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
app.listen(PORT, () => console.log(`🚀 Neural Worker (R2 Enabled) active on port ${PORT}`));
app.get("/", (_, res) => res.send("OK"));
/* ========================================================= */
/* UTILITIES                                                 */
/* ========================================================= */
async function callGeminiWithRetry(fn, isPro = false) {
    const maxRetries = isPro ? 6 : 3;
    const baseDelay = isPro ? 5000 : 2000;
    for (let i = 0; i < maxRetries; i++) {
        try { return await fn(); }
        catch (err) {
            if (err.status === 503 || err.status === 429) {
                const delay = (Math.pow(2, i) * baseDelay) + (Math.random() * 2000);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
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
    if (req.headers["x-worker-secret"] !== process.env.WORKER_SECRET) return res.status(401).send("UNAUTHORIZED");
    let job;
    try {
        // Note: ensure your DB function is claiming correctly
        const { data } = await supabase.rpc("claim_next_ai_job");
        if (!data) return res.sendStatus(204);
        job = data;
        console.log(`▶ Processing job ${job.id} [${job.type}]`);
        let result;
        if (job.type === "generate-image") result = await generateImage(job);
        else if (job.type === "analyze-material") result = await analyzeMaterial(job);
        else throw new Error(`UNSUPPORTED: ${job.type}`);
        await supabase.from("ai_jobs").update({ status: "completed", result }).eq("id", job.id);
        return res.sendStatus(200);
    } catch (err) {
        console.error("🔥 Fault:", err.message);
        if (job) await supabase.from("ai_jobs").update({ status: "failed", error: err.message }).eq("id", job.id);
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
    const modelName = config.model?.includes("pro") ? "gemini-3-pro-image-preview" : "gemini-2.5-flash-image";
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
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
    console.log("🧠 Calling Gemini API...");
    const response = await callGeminiWithRetry(() =>
        ai.models.generateContent({
            model: modelName,
            contents: { parts },
            config: { imageConfig: { aspectRatio: config.aspectRatio || "1:1", imageSize: "1K" } }
        }), true
    );
    console.log("✅ Gemini Success. Extracting Data...");
    const base64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64) throw new Error("No image generated");
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
        file_id: crypto.randomUUID(), // or let DB auto-gen if using uuid_generate_v4()
        r2_key: r2Key,
        filename: fileName,
        file_size: fileBuffer.length,
        mime_type: "image/png",
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
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
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
