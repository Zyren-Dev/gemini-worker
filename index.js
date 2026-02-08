import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import 'dotenv/config'; // Ensure persistence of env vars

const app = express();
app.use(express.json({ limit: "50mb" })); // Increased limit for base64 I/O

/* ========================================================= */
/* CONFIGURATION                                             */
/* ========================================================= */
const supabase = createClient(
    process.env.SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

const r2 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
    },
});

const R2_BUCKET = process.env.R2_BUCKET_NAME || "user-files";
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => console.log(`🚀 Neural Worker (Push Model) active on port ${PORT}`));

app.get("/", (_, res) => res.send("OK"));

/* ========================================================= */
/* UTILITIES                                                 */
/* ========================================================= */
async function callGeminiWithRetry(fn, isPro = false) {
    const maxRetries = 3; // Reduced from 6 to fail faster during debug
    const baseDelay = isPro ? 5000 : 2000;

    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        }
        catch (err) {
            console.warn(`⚠️ API Attempt ${i + 1}/${maxRetries} failed: ${err.status || err.message}`);
            if (i === maxRetries - 1) throw err; // Re-throw on last attempt

            if (err.status === 503 || err.status === 429 || err.status === 500) {
                const delay = (Math.pow(2, i) * baseDelay) + (Math.random() * 2000);
                console.log(`⏳ Waiting ${Math.round(delay)}ms before retry...`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err; // verification failed, rethrow immediately for other errors
        }
    }
}

// Helper to download file from R2
async function downloadFromR2(key) {
    try {
        const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
        const response = await r2.send(command);
        const byteArray = await response.Body.transformToByteArray();
        return Buffer.from(byteArray).toString("base64");
    } catch (err) {
        console.error(`Failed to download ${key} from R2:`, err);
        throw new Error(`Reference image not found: ${key}`);
    }
}

/* ========================================================= */
/* JOB WORKER ENDPOINT                                       */
/* ========================================================= */
app.post("/process", async (req, res) => {
    // Security Check
    if (req.headers["x-worker-secret"] !== process.env.WORKER_SECRET) {
        return res.status(401).send("UNAUTHORIZED");
    }

    let job = {}; // Initialize empty object

    try {
        // 1. Get Job from Request (Push Model)
        // REPLACED: claim_next_ai_job with explicit payload from Edge Function
        const { job_id, action, payload, user_id } = req.body;

        console.log(`▶ Received request for Job ${job_id} [${action}]`);

        // 2. Validate Action (Prevent Video job processing)
        if (action !== 'generate-image' && action !== 'analyze-material') {
            console.warn(`⚠️ Ignoring unsupported action: ${action}`);
            // Return 400 so the caller knows it sent it to the wrong place
            return res.status(400).json({ error: `Unsupported action: ${action}` });
        }

        // 3. Construct Job Object (matching DB structure for internal logic)
        job = {
            id: job_id,
            type: action,
            input: payload,
            user_id: user_id,
            cost: 0 // We don't have cost here, but usually validation happens before payment deduction in the manager.
        };

        console.log(`▶ Processing job ${job.id} [${job.type}]`);

        let result;
        if (job.type === "generate-image") result = await generateImage(job);
        else if (job.type === "analyze-material") result = await analyzeMaterial(job);

        // FIX: Check for errors when updating ai_jobs!
        const { error: dbUpdateError } = await supabase.from("ai_jobs").update({ status: "completed", result }).eq("id", job.id);

        if (dbUpdateError) {
            console.error(`[Job ${job.id}] FAILED to update ai_jobs:`, dbUpdateError);
            return res.status(500).json({ error: "Failed to update job status" });
        }

        console.log(`[Job ${job.id}] Completed successfully.`);
        return res.sendStatus(200);

    } catch (err) {
        console.error("🔥 Fault:", err.message);
        if (job && job.id) {
            // 1. Mark Job Failed
            await supabase.from("ai_jobs").update({ status: "failed", error: err.message }).eq("id", job.id);

            // 2. Refund Credits 
            // Only if we have cost info, otherwise relying on manual refund or separate process
            if (job.cost && job.cost > 0) {
                console.log(`💸 Refunding ${job.cost} credits to user ${job.user_id}...`);
                const { error: refundError } = await supabase.rpc("refund_credits", {
                    p_user_id: job.user_id,
                    p_amount: job.cost,
                    p_metadata: { reason: "job_failed", error: err.message, job_id: job.id }
                });
                if (refundError) console.error("Refund failed:", refundError);
            }
        }
        return res.status(500).send(err.message);
    }
});

/* ========================================================= */
/* LOGIC: GENERATE IMAGE                                     */
/* ========================================================= */
async function generateImage(job, overridePrompt, overrideConfig) {
    const input = job.input;
    const prompt = overridePrompt || input.prompt;
    const config = overrideConfig || input.config;

    // REVERTED: User was correct! These are the new Nano Banana models.
    const modelName = config.model?.includes("pro") ? "gemini-3-pro-image-preview" : "gemini-2.5-flash-image";

    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || process.env.GOOGLE_API_KEY });
    const parts = [{ text: prompt }];

    // Handle References (Download from R2)
    if (input.referenceImages?.length && !overridePrompt) {
        console.log("⬇️ Downloading Reference Images from R2...");
        for (const ref of input.referenceImages) {
            // ref.path should be the R2 Key (e.g. users/123/file.png)
            console.log(`   Downloading ${ref.path}...`);
            const base64 = await downloadFromR2(ref.path);
            console.log(`   Download complete.`);
            parts.push({ inlineData: { mimeType: ref.mime || "image/png", data: base64 } });
        }
    }

    console.log(`🧠 Calling Gemini API (${modelName})...`);

    // Config specifically for Gemini 3 Pro Image (Nano Banana)
    let generationConfig = undefined;
    if (modelName === "gemini-3-pro-image-preview") {
        generationConfig = {
            responseModalities: ["TEXT", "IMAGE"], // Documented requirement
            imageConfig: {
                aspectRatio: config.aspectRatio || "1:1",
                // imageSize: config.imageSize || "1K" 
            }
        };
    } else {
        // Force IMAGE modality for Flash Image to prevent text-only fallbacks
        generationConfig = {
            responseModalities: ["IMAGE"]
        };
    }

    // Attempt generation
    const response = await callGeminiWithRetry(() =>
        ai.models.generateContent({
            model: modelName,
            contents: parts, // PASSED DIRECTLY (Array of Parts) matches User Snippet
            config: generationConfig
        }), true
    );

    console.log("✅ Gemini Success. Extracting Data...");

    let base64;

    // STRATEGY 1: Check for 'generatedImages' (New SDK structure for Imagen/Flash-Image)
    if (response.generatedImages && response.generatedImages.length > 0) {
        console.log("Found image in response.generatedImages");
        base64 = response.generatedImages[0].image.imageBytes;
    }
    // STRATEGY 2: Standard Candidates (Multimodal)
    else {
        console.log("Checking response.candidates for inlineData...");
        const partsList = response.candidates?.[0]?.content?.parts || [];
        const imagePart = partsList.find(p => p.inlineData && p.inlineData.data);
        base64 = imagePart?.inlineData?.data;
    }

    if (!base64) {
        console.error("Full Response:", JSON.stringify(response, null, 2)); // Log Full Response for Debugging
        throw new Error("No image generated (Check text output in logs if available)");
    }

    // Upload to R2
    const extension = "png";
    const fileName = `${crypto.randomUUID()}.${extension}`;
    const r2Key = `users/${job.user_id}/renders/${fileName}`;
    const fileBuffer = Buffer.from(base64, "base64");

    console.log(`⬆️ Uploading Result to R2 (${r2Key})...`);

    await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: r2Key,
        Body: fileBuffer,
        ContentType: "image/png",
    }));

    console.log("✅ Upload Complete.");

    // Register in user_files DB (Important for Library visibility!)
    const { error: dbError } = await supabase.from("user_files").insert({
        user_id: job.user_id,
        file_id: crypto.randomUUID(),
        r2_key: r2Key,
        file_name: fileName,
        file_size: fileBuffer.length,
        mime_type: "image/png",
        asset_category: "render", // NEW: Classify as AI Render
        status: "active"
    });

    if (dbError) console.error("Failed to register render in user_files:", dbError);

    // Generate Signed URL for immediate display
    const signedUrl = await getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }), { expiresIn: 604800 }); // 7 days

    return { imageUrl: signedUrl, storagePath: r2Key, bucket: "r2" };
}

/* ========================================================= */
/* LOGIC: ANALYZE MATERIAL + PREVIEW                         */
/* ========================================================= */
async function analyzeMaterial(job) {
    console.log(`🧠 Analyzing Material...`);
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || process.env.GOOGLE_API_KEY });
    const isPro = job.input.config?.model?.includes("pro");
    const textModel = isPro ? "gemini-1.5-pro-002" : "gemini-1.5-flash";
    const ref = job.input.referenceImage;
    const base64 = await downloadFromR2(ref.path);
    const parts = [
        { text: "Analyze this texture. Return JSON: { name, color (hex), description }." },
        { inlineData: { mimeType: ref.mime, data: base64 } }
    ];

    const analysisRes = await callGeminiWithRetry(() =>
        ai.models.generateContent({ model: textModel, contents: { parts }, config: { responseMimeType: "application/json" } })
    );

    const analysis = JSON.parse(analysisRes.candidates[0].content.parts[0].text);
    console.log(`🎨 Generating Preview for: ${analysis.name}`);
    const previewPrompt = `Hyper-realistic spherical material preview of ${analysis.name}. ${analysis.description}. Studio lighting, dark background, 8k resolution.`;

    // Reuse generateImage logic for the preview sphere
    const previewResult = await generateImage(job, previewPrompt, { model: 'gemini-3-pro-image-preview', aspectRatio: '1:1' });

    return { analysis: analysis, previewUrl: previewResult.imageUrl };
}
