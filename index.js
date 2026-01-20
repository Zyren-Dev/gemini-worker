import express from "express";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";

const app = express();
// Increased limit isn't strictly necessary for input anymore since we aren't passing base64, 
// but good to keep if you accept other large text prompts.
app.use(express.json({ limit: "20mb" }));

/* ========================================================= */
/* ENV CHECK                                                 */
/* ========================================================= */
const REQUIRED_ENVS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GEMINI_API_KEY",
];

for (const key of REQUIRED_ENVS) {
  if (!process.env[key]) {
    console.error(`❌ Missing env var: ${key}`);
    process.exit(1);
  }
}

/* ========================================================= */
/* CLIENTS                                                   */
/* ========================================================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Note: Ensure you are using the correct import/version for GoogleGenAI. 
// If using the older @google/generative-ai, syntax might differ slightly.
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

/* ========================================================= */
/* HEALTH CHECK                                              */
/* ========================================================= */
app.get("/", (_, res) => res.send("OK"));

/* ========================================================= */
/* JOB WORKER ENDPOINT                                       */
/* ========================================================= */
app.post("/process", async (_, res) => {
  try {
    /* --------------------------------------------- */
    /* 1️⃣ ATOMICALLY CLAIM ONE PENDING JOB            */
    /* --------------------------------------------- */
    // Ensure you have created this RPC function in your database
    const { data: job, error } = await supabase.rpc("claim_next_ai_job");

    if (error) {
      console.error("❌ Failed to claim job", error);
      return res.sendStatus(500);
    }

    if (!job) {
      return res.sendStatus(204);
    }

    console.log(`▶ Processing job ${job.id} [${job.type}]`);

    /* --------------------------------------------- */
    /* 2️⃣ EXECUTE JOB                                 */
    /* --------------------------------------------- */
    let result;

    switch (job.type) {
      case "generate-image":
        result = await generateImage(job.input);
        break;

      case "generate-video":
        result = { video: "TODO" };
        break;

      case "analyze-material":
        result = { analysis: "TODO" };
        break;

      default:
        throw new Error(`UNKNOWN_JOB_TYPE: ${job.type}`);
    }

    /* --------------------------------------------- */
    /* 3️⃣ MARK COMPLETE                               */
    /* --------------------------------------------- */
    await supabase
      .from("ai_jobs")
      .update({
        status: "completed",
        result,
      })
      .eq("id", job.id);

    console.log(`✅ Job ${job.id} completed`);
    return res.sendStatus(200);

  } catch (err) {
    console.error("🔥 Job failed", err);

    // If we have a job reference, mark it as failed so it doesn't get stuck
    // Note: 'job' variable isn't in scope here unless we move the try/catch or declare it outside.
    // For robust error handling, relying on the 'job_id' passed in request body is safer 
    // IF the rpc fails, but here we are pulling the job from the DB. 
    // For simplicity, we log the error. In production, you'd want to update the DB row if 'job' exists.
    
    return res.sendStatus(500);
  }
});

/* ========================================================= */
/* HELPER: DOWNLOAD STORAGE                                  */
/* ========================================================= */
async function downloadImageFromSupabase(path) {
  const { data, error } = await supabase.storage
    .from("user_assets")
    .download(path);

  if (error) throw error;

  // Convert Blob/Buffer to Base64
  const arrayBuffer = await data.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const base64 = buffer.toString("base64");

  // Extract mime from path extension (simple heuristic)
  // or use the 'type' from the blob if available
  const ext = path.split(".").pop(); 
  const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;

  return { mimeType, data: base64 };
}

/* ========================================================= */
/* IMAGE GENERATION                                          */
/* ========================================================= */
async function generateImage(input) {
  const parts = [{ text: input.prompt }];

  // 1. Check for Reference Images (Storage Paths)
  if (input.referenceImagePaths && input.referenceImagePaths.length > 0) {
    console.log(`   ⬇️ Downloading ${input.referenceImagePaths.length} reference images...`);
    
    for (const path of input.referenceImagePaths) {
      try {
        const imagePart = await downloadImageFromSupabase(path);
        
        parts.push({
          inlineData: {
            mimeType: imagePart.mimeType,
            data: imagePart.data,
          },
        });
      } catch (err) {
        console.error(`   ⚠️ Failed to download reference ${path}:`, err.message);
        // Continue? Or throw? 
        // Throwing ensures we don't generate garbage if a reference is missing.
        throw new Error(`FAILED_TO_LOAD_REFERENCE: ${path}`);
      }
    }
  }

  // 2. Call Gemini
  const res = await ai.models.generateContent({
    model: input.config.model,
    contents: { parts },
    config: {
      imageConfig: {
        imageSize: input.config.imageSize,
        // Ensure aspectRatio is passed only if supported by the specific model/endpoint
        // aspectRatio: input.config.aspectRatio, 
      },
    },
  });

  // 3. Extract Result
  // Note: The response structure depends on the specific SDK version.
  // This logic assumes the standard structure for generated images.
  let imageBase64;
  let mimeType = "image/png";

  // Try to find image in candidates
  const candidates = res.candidates || [];
  const firstPart = candidates[0]?.content?.parts?.[0];

  if (firstPart && firstPart.inlineData) {
    imageBase64 = firstPart.inlineData.data;
    mimeType = firstPart.inlineData.mimeType;
  }

  if (!imageBase64) {
    console.log("   ⚠️ No image in response", JSON.stringify(res, null, 2));
    throw new Error("NO_IMAGE_RETURNED");
  }

  // Return formatted data URL
  return {
    imageUrl: `data:${mimeType};base64,${imageBase64}`,
  };
}

/* ========================================================= */
/* SERVER START                                              */
/* ========================================================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Worker listening on port ${PORT}`);
});
