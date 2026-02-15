import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import 'dotenv/config';

const app = express();
app.use(express.json({ limit: "50mb" }));

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

async function callGeminiWithRetry(fn, isPro = false) {
    const maxRetries = 3;
    const baseDelay = isPro ? 5000 : 2000;

    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        }
        catch (err) {
            console.warn(`⚠️ API Attempt ${i + 1}/${maxRetries} failed: ${err.status || err.message}`);
            if (i === maxRetries - 1) throw err;

            if (err.status === 503 || err.status === 429 || err.status === 500) {
                const delay = (Math.pow(2, i) * baseDelay) + (Math.random() * 2000);
                console.log(`⏳ Waiting ${Math.round(delay)}ms before retry...`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
}

async function downloadFromR2(key) {
    try {
        const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
        const response = await r2.send(command);
        if (!response.Body) throw new Error("Empty body");
        const byteArray = await response.Body.transformToByteArray();
        return Buffer.from(byteArray).toString("base64");
    } catch (err) {
        console.error(`Failed to download ${key} from R2:`, err);
        throw new Error(`Reference image not found: ${key}`);
    }
}

async function generateImage(job, overridePrompt, overrideConfig) {
    const input = job.input;
    const prompt = overridePrompt || input.prompt;
    const config = overrideConfig || input.config;
    const modelName = config.model?.includes("pro") ? "gemini-3-pro-image-preview" : "gemini-2.5-flash-image";

    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY || process.env.API_KEY });
    const parts = [{ text: prompt }];

    if (input.referenceImages?.length && !overridePrompt) {
        for (const ref of input.referenceImages) {
            const base64 = await downloadFromR2(ref.path);
            parts.push({ inlineData: { mimeType: ref.mime || "image/png", data: base64 } });
        }
    }

    let generationConfig = undefined;
    if (modelName === "gemini-3-pro-image-preview") {
        generationConfig = {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: { aspectRatio: config.aspectRatio || "1:1" }
        };
    } else {
        // FLASH: Imagen 3 (Flash) often requires imageConfig even if simple
        generationConfig = {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: config.aspectRatio || "1:1" }
        };
    }

    const isPro = modelName.includes("pro");
    const response = await callGeminiWithRetry(() =>
        ai.models.generateContent({
            model: modelName,
            contents: parts,
            config: generationConfig
        }), isPro
    );

    console.log("✅ Gemini Success. Extracting Data...");

    let base64;
    if (response.generatedImages && response.generatedImages.length > 0) {
        base64 = response.generatedImages[0].image.imageBytes;
    } else {
        const partsList = response.candidates?.[0]?.content?.parts || [];
        const imagePart = partsList.find((p) => p.inlineData && p.inlineData.data);
        base64 = imagePart?.inlineData?.data;
    }

    if (!base64) {
        console.error("🔍 NO IMAGE FOUND. FULL RESPONSE:", JSON.stringify(response, null, 2));
        throw new Error("No image generated (Check logs for structure)");
    }

    const extension = "png";
    const fileName = `${crypto.randomUUID()}.${extension}`;
    const r2Key = `users/${job.user_id}/renders/${fileName}`;
    const fileBuffer = Buffer.from(base64, "base64");

    await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: r2Key,
        Body: fileBuffer,
        ContentType: "image/png",
    }));

    if (job.user_id) {
        await supabase.from("user_files").insert({
            user_id: job.user_id,
            file_id: crypto.randomUUID(),
            r2_key: r2Key,
            file_name: fileName,
            file_size: fileBuffer.length,
            mime_type: "image/png",
            asset_category: "render",
            status: "active"
        });
    }

    const signedUrl = await getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }), { expiresIn: 604800 });
    return { imageUrl: signedUrl, storagePath: r2Key, bucket: "r2" };
}

async function analyzeMaterial(job) {
    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY || process.env.API_KEY });
    const isPro = job.input.config?.model?.includes("pro");
    const textModel = isPro ? "gemini-2.5-flash" : "gemini-1.5-flash";
    const ref = job.input.referenceImage;

    if (!ref || !ref.path) throw new Error("Missing reference image for analysis");

    const base64 = await downloadFromR2(ref.path);
    const parts = [
        { text: "Analyze this texture. Return JSON: { name, color (hex), description }." },
        { inlineData: { mimeType: ref.mime || 'image/png', data: base64 } }
    ];

    const analysisRes = await callGeminiWithRetry(() =>
        ai.models.generateContent({ model: textModel, contents: parts, config: { responseMimeType: "application/json" } })
    );

    const textPart = analysisRes.candidates?.[0]?.content?.parts?.[0]?.text;
    const analysis = JSON.parse(textPart);
    const previewPrompt = `Hyper-realistic detailed spherical material preview of ${analysis.name}. ${analysis.description}. Studio lighting, light gray background, 8k resolution.`;
    const previewResult = await generateImage(job, previewPrompt, { model: 'gemini-3-pro-image-preview', aspectRatio: '1:1' });

    return { analysis: analysis, previewUrl: previewResult.imageUrl };
}

app.post("/process", async (req, res) => {
    if (req.headers["x-worker-secret"] !== process.env.WORKER_SECRET) return res.status(401).send("UNAUTHORIZED");

    let job = {};
    try {
        const { job_id, action, payload, user_id, cost } = req.body;
        if (action !== 'generate-image' && action !== 'analyze-material') return res.status(400).json({ error: `Unsupported action: ${action}` });

        job = { id: job_id, type: action, input: payload, user_id: user_id, cost: cost };
        let result;
        if (job.type === "generate-image") result = await generateImage(job);
        else if (job.type === "analyze-material") result = await analyzeMaterial(job);

        await supabase.from("ai_jobs").update({
            status: "completed",
            result,
            updated_at: new Date().toISOString()
        }).eq("id", job.id);

        return res.sendStatus(200);
    } catch (err) {
        if (job.id) {
            await supabase.from("ai_jobs").update({
                status: "failed",
                error: err.message,
                updated_at: new Date().toISOString()
            }).eq("id", job.id);

            if (job.cost > 0) {
                await supabase.rpc("refund_credits", {
                    p_user_id: job.user_id,
                    p_amount: job.cost,
                    p_metadata: { reason: "job_failed", error: err.message },
                    p_job_id: job.id
                });
            }
        }
        return res.status(500).send(err.message);
    }
});

app.listen(PORT, () => console.log(`🚀 Neural Worker active on port ${PORT}`));
app.get("/", (_, res) => res.send("OK"));
