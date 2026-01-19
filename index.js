import express from "express";
import { GoogleGenerativeAI, Type } from "@google/generative-ai";

const app = express();
app.use(express.json({ limit: "20mb" }));

/* ------------------------------------------------------------------ */
/* Gemini setup                                                        */
/* ------------------------------------------------------------------ */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* ------------------------------------------------------------------ */
/* Main worker endpoint                                                */
/* ------------------------------------------------------------------ */
app.post("/process", async (req, res) => {
  try {
    const { action, payload, user_id } = req.body;

    if (!action || !payload) {
      return res.status(400).json({ error: "INVALID_REQUEST" });
    }

    console.log("WORKER ACTION:", action, "USER:", user_id);

    switch (action) {
      /* ============================================================ */
      /* IMAGE GENERATION                                             */
      /* ============================================================ */
      case "generate-image": {
        const model = genAI.getGenerativeModel({
          model: payload.config.model,
        });

        const parts = [{ text: payload.prompt }];

        if (payload.referenceImages) {
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

        for (const part of result.response.candidates?.[0]?.content?.parts ?? []) {
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

      /* ============================================================ */
      /* VIDEO GENERATION                                             */
      /* ============================================================ */
      case "generate-video": {
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
          operation.response?.generatedVideos?.[0]?.video?.uri;

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

      /* ============================================================ */
      /* IMAGE ANALYSIS                                               */
      /* ============================================================ */
      case "analyze-material": {
        const model = genAI.getGenerativeModel({
          model: "gemini-3-flash-preview",
        });

        const match = payload.image.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
          throw new Error("INVALID_IMAGE");
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
                { text: "Return strictly valid JSON." },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                description: { type: Type.STRING },
                color: { type: Type.STRING },
                category: { type: Type.STRING },
              },
              required: ["name", "description", "color", "category"],
            },
          },
        });

        return res.json({
          analysis: JSON.parse(result.response.text()),
        });
      }

      /* ============================================================ */
      /* UNKNOWN                                                      */
      /* ============================================================ */
      default:
        return res.status(400).json({ error: "UNKNOWN_ACTION" });
    }
  } catch (err) {
    console.error("WORKER ERROR:", err);
    return res.status(500).json({
      error: "WORKER_EXECUTION_FAILED",
      message: err.message,
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
