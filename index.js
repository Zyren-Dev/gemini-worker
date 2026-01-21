import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "5mb" }));

/* ========================================================= */
/* CLIENTS & ENV                                             */
/* ========================================================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Note: Ensure you are using the @google/genai SDK (not @google/generative-ai)
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

/* ========================================================= */
/* WORKER ENDPOINT                                           */
/* ========================================================= */
app.post("/process", async (req, res) => {
  if (req.headers["x-worker-secret"] !== process.env.WORKER_SECRET) {
    return res.sendStatus(401);
  }

  let job;
  try {
    const { data, error } = await supabase.rpc("claim_next_ai_job");
    if (error || !data) return res.sendStatus(error ? 500 : 204);
    job = data;

    console.log(`▶ Processing ${job.id} with ${job.input.config.model}`);

    const result = await generateBananaImage(job);

    await supabase.from("ai_jobs").update({
      status: "completed",
      result,
    }).eq("id", job.id);

    return res.sendStatus(200);
  } catch (err) {
    console.error("🔥 Job Failed:", err);
    if (job) {
      await supabase.from("ai_jobs").update({
        status: "failed",
        error: String(err),
      }).eq("id", job.id);
    }
    return res.sendStatus(500);
  }
});

/* ========================================================= */
/* NANO BANANA GENERATION LOGIC                              */
/* ========================================================= */
async function generateBananaImage(job) {
  const { prompt, config, referenceImages } = job.input;
  
  // 1. Prepare contents (Text + optional Reference Images)
  const parts = [{ text: prompt }];

  if (referenceImages?.length) {
    for (const ref of referenceImages) {
      const { data, error } = await supabase.storage.from(ref.bucket).download(ref.path);
      if (error) throw error;
      
      parts.push({
        inlineData: {
          mimeType: ref.mime || "image/png",
          data: Buffer.from(await data.arrayBuffer()).toString("base64"),
        },
      });
    }
  }

  // 2. Execute call using generateContent (Native Modality)
  const response = await ai.models.generateContent({
    model: config.model || "gemini-3-pro-image-preview",
    contents: [{ role: "user", parts }],
    config: {
      // CRITICAL: Tells the model to generate an image
      responseModalities: ["IMAGE"], 
      imageConfig: {
        aspectRatio: config.aspectRatio || "1:1",
        // Pro supports "2K" or "4K", Flash usually defaults to 1K
        imageSize: config.imageSize || "1K", 
      }
    },
  });

  // 3. Extract the generated image from response parts
  let imageBase64;
  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
      imageBase64 = part.inlineData.data;
      break;
    }
  }

  if (!imageBase64) throw new Error("Model failed to return image data");

  // 4. Upload to Supabase
  const buffer = Buffer.from(imageBase64, "base64");
  const fileName = `${crypto.randomUUID()}.png`;
  const path = `users/${job.user_id}/renders/${fileName}`;

  await supabase.storage.from("user_assets").upload(path, buffer, {
    contentType: "image/png",
  });

  const { data } = await supabase.storage.from("user_assets").createSignedUrl(path, 300);

  return { image_url: data.signedUrl };
}

app.listen(8080);
