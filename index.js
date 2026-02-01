import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "5mb" }));

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Neural Worker active on port ${PORT}`));

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

/* ========================================================= */
/* JOB WORKER ENDPOINT                                       */
/* ========================================================= */
app.post("/process", async (req, res) => {
  if (req.headers["x-worker-secret"] !== process.env.WORKER_SECRET) return res.status(401).send("UNAUTHORIZED");

  let job;
  try {
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

  // ✅ CORRECT MODEL SELECTION FOR IMAGES
  const modelName = config.model?.includes("pro") ? "gemini-3-pro-image-preview" : "gemini-2.5-flash-image";
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const parts = [{ text: prompt }];

  if (input.referenceImages?.length && !overridePrompt) {
    for (const ref of input.referenceImages) {
      const { data } = await supabase.storage.from(ref.bucket).download(ref.path);
      const base64 = Buffer.from(await data.arrayBuffer()).toString("base64");
      parts.push({ inlineData: { mimeType: ref.mime || "image/png", data: base64 } });
    }
  }

  const response = await callGeminiWithRetry(() => 
    ai.models.generateContent({ 
        model: modelName, 
        contents: { parts }, 
        config: { imageConfig: { aspectRatio: config.aspectRatio || "1:1", imageSize: "1K" } } 
    }), true
  );

  const base64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64) throw new Error("No image generated");

  const fileName = `${crypto.randomUUID()}.png`;
  const path = `users/${job.user_id}/renders/${fileName}`;
  await supabase.storage.from("user_assets").upload(path, Buffer.from(base64, "base64"), { contentType: "image/png" });
  const { data } = await supabase.storage.from("user_assets").createSignedUrl(path, 60*60*24*7);

  return { imageUrl: data.signedUrl, storagePath: path };
}

/* ========================================================= */
/* LOGIC: ANALYZE MATERIAL + PREVIEW                         */
/* ========================================================= */
async function analyzeMaterial(job) {
  console.log(`🧠 Analyzing Material...`);
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  // ✅ FIX: DYNAMIC TEXT MODEL SLECTION
  // If user selected "Pro", we use "1.5-pro-002" (stable pro).
  // Otherwise we default to "1.5-flash" (safer, faster).
  const isPro = job.input.config?.model?.includes("pro");
  const textModel = isPro ? "gemini-1.5-pro-002" : "gemini-1.5-flash"; 
  
  console.log(`Using Text Model: ${textModel}`);

  const ref = job.input.referenceImage;
  const { data } = await supabase.storage.from(ref.bucket).download(ref.path);
  const base64 = Buffer.from(await data.arrayBuffer()).toString("base64");
  
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
  // Note: We force 'gemini-3-pro' for the preview to ensure it looks beautiful
  const previewResult = await generateImage(job, previewPrompt, { model: 'gemini-3-pro-image-preview', aspectRatio: '1:1' });

  return { analysis: analysis, previewUrl: previewResult.imageUrl };
}
