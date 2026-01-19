import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(express.json({ limit: "25mb" }));

/* ------------------------------------------------------------------ */
/* Gemini client                                                       */
/* ------------------------------------------------------------------ */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* ------------------------------------------------------------------ */
/* Health check (optional but useful)                                  */
/* ------------------------------------------------------------------ */
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

/* ------------------------------------------------------------------ */
/* Main worker endpoint                                                */
/* ------------------------------------------------------------------ */
app.post("/process", async (req, res) => {
  try {
    const { action, payload, user_id } = req.body;

    if (!action || !payload) {
      return res.status(400).json({ error: "INVALID_REQUEST" });
    }

    console.log("ACTION:", action, "USER:", user_id ?? "unknown");

    /* =============================================================== */
    /* IMAGE GENERATION                                                */
    /* =============================================================== */
    if (action === "generate-image") {
      const model = genAI.getGenerativeModel({
        model: payload.config.model,
      });

      const parts = [{ text: payload.prompt }];

      if (payload.referenceImages?.length) {
        for (const img of payload.referenceImages) {
          const match = img.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            parts.push({
              inlineData: {
                mimeType: match[1],
                data: match[2],
              },
            });
          }
        }
      }

      const result = await model.generateContent({
        contents: [{ role: "user", parts }],
        generationConfig: {
          imageConfig: {
            aspectRatio: payload.config.aspectRatio,
            imageSize: payload.config.imageSize,
          },
        },
      });

      let imageUrl = "";

      const contentParts =
        result?.response?.candidates?.[0]?.content?.parts ?? [];

      for (const part of contentParts) {
        if (part.inlineData) {
          imageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
          break;
        }
      }

      if (!imageUrl) {
        throw new Error("IMAGE_GENERATION_FAILED");
      }

      return res.json({ imageUrl });
    }

    /* =============================================================== */
    /* VIDEO GENERATION                                                */
    /* =============================================================== */
    if (action === "generate-video") {
      let operation = await genAI.models.generateVideos({
        model: payload.config.model,
        prompt: payload.prompt,
        config: {
          resolution: payload.config.resolution,
          aspectRatio: payload.config.aspectRatio,
          numberOfVideos: 1,
        },
      });

      while (!operation.done) {
        await new Promise((r) => setTimeout(r, 10_000));
        operation = await genAI.operations.getVideosOperation({
          operation,
        });
      }

      const uri =
        operation?.response?.generatedVideos?.[0]?.video?.uri;

      if (!uri) {
        throw new Error("VIDEO_GENERATION_FAILED");
      }

      const videoRes = await fetch(`${uri}&key=${process.env.GEMINI_API_KEY}`);
      const buffer = await videoRes.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");

      return res.json({
        videoData: `data:video/mp4;base64,${base64}`,
      });
    }

    /* =============================================================== */
    /* IMAGE ANALYSIS                                                  */
    /* =============================================================== */
    if (action === "analyze-material") {
      const model = genAI.getGenerativeModel({
        model: "gemini-3-flash-preview",
      });

      const match = payload.image.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        return res.status(400).json({ error: "INVALID_IMAGE" });
      }

      const result = await model.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: match[1],
                  data: match[2],
                },
              },
              {
                text: `Analyze this image and return STRICT JSON exactly like this:
{
  "name": "string",
  "description": "string",
  "color": "string",
  "category": "string"
}`,
              },
            ],
          },
        ],
      });

      const text = result?.response?.text?.();
      if (!text) {
        throw new Error("ANALYSIS_FAILED");
      }

      return res.json({
        analysis: JSON.parse(text),
      });
    }

    /* =============================================================== */
    /* UNKNOWN ACTION                                                  */
    /* =============================================================== */
    return res.status(400).json({ error: "UNKNOWN_ACTION" });
  } catch (err) {
    console.error("WORKER ERROR:", err);
    return res.status(500).json({
      error: "WORKER_EXECUTION_FAILED",
      message: err?.message ?? "Unknown error",
    });
  }
});

/* ------------------------------------------------------------------ */
/* Start server                                                        */
/* ------------------------------------------------------------------ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Gemini worker running on port", PORT);
});
