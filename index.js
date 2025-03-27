import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";

const app = express();
const port = process.env.PORT || 3000;

// Allow requests only from your frontend domain
app.use(
  cors({
    origin: `${process.env.url}`,
    methods: ["GET", "POST"], // Allowed methods
  })
);
app.use(express.json());
const limiter = rateLimit({
   windowMs: 1 * 30 * 1000, // 30s  window
   max: 30, // limit each IP to 30 requests per windowMs
   message: { error: "Too many requests, please try again later." },
 });
// Middleware to check the API key for secured endpoints
function checkApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (apiKey && apiKey === process.env.CLIENT_API_KEY) {
    return next();
  }
  return res.status(403).json({ error: "Forbidden: Invalid API key." });
}

// Apply API key check to specific routes
app.use("/filter-songs", checkApiKey);
app.use("/smart-search", checkApiKey);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);



// Test endpoint
app.get("/test", (req, res) => {
  res.send("running...");
});
app.get("/favicon.ico", (req, res) => {
  res.sendStatus(204); // No Content
});

// Endpoint for filtering songs
app.post("/filter-songs", async (req, res) => {
  try {
    const songs = req.body.songs || [];
    const prompt = `Return your output as valid JSON. The JSON should have a key "suggestions" that holds an array of objects.
Each object must have "name", "artist", and "reason" keys. Do not include any markdown or extra text.
Suggest songs similar to: ${JSON.stringify(songs)}`;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: {
        role: "model",
        parts: [
          {
            text: "You are an expert music recommender. Only output valid JSON without markdown formatting or extra text.",
          },
        ],
      },
    });

    const response = await model.generateContent(prompt);
    let output = response.response.text();

    // Remove markdown formatting if present
    output = output
      .replace(/```(json)?\n/g, "")
      .replace(/```/g, "")
      .trim();

    const suggestions = JSON.parse(output);
    res.json({
      suggestedSongs: suggestions,
    });
  } catch (error) {
    console.error("Gemini API error:", error);
    res.status(500).json({ error: "Error generating song suggestions" });
  }
});

// Endpoint for smart song search
app.post("/smart-search", async (req, res) => {
  try {
    const userInput = req.body.songs || [];
    const prompt = `Return your output as valid JSON. The JSON should have a key "songs" that holds an array of song titles.
If the user specifies a song, return it in JSON format.
User input: ${JSON.stringify(userInput)}`;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: {
        role: "model",
        parts: [
          {
            text: `You are an expert music recommender. Your task is to return only a **valid JSON object** without markdown formatting or extra text.
- If the user specifies a song, return it in JSON format.
- If the user does not specify a song, suggest **exactly 10 songs**.
- The JSON **must** have a key "songs" with an **array of song titles**.

⚠️ IMPORTANT: Always return a **single valid JSON object** without triple backticks or any extra text.

🎯 Example JSON output:
{
  "songs": [
    "Shape of You - Ed Sheeran",
    "Blinding Lights - The Weeknd",
    "Someone Like You - Adele",
    "Believer - Imagine Dragons",
    "Levitating - Dua Lipa",
    "Happier - Marshmello",
    "Memories - Maroon 5",
    "Perfect - Ed Sheeran",
    "Uptown Funk - Mark Ronson ft. Bruno Mars",
    "Señorita - Shawn Mendes & Camila Cabello"
  ]
}`,
          },
        ],
      },
    });

    const response = await model.generateContent(prompt);
    let output = response.response.text();

    console.log("Raw response from Gemini:", output);

    // Clean the response from markdown formatting
    output = output
      .replace(/```(json)?\n/g, "")
      .replace(/```/g, "")
      .trim();

    let suggestions;
    try {
      suggestions = JSON.parse(output);
    } catch (parseError) {
      console.error("JSON Parse Error:", parseError);
      return res
        .status(500)
        .json({ error: "Failed to parse response from AI" });
    }

    if (!suggestions || !Array.isArray(suggestions.songs)) {
      console.error("Invalid JSON structure:", suggestions);
      return res.status(500).json({ error: "Unexpected JSON format" });
    }

    const placeholderImage = "https://via.placeholder.com/150";
    const FilterSongs = await Promise.all(
      suggestions.songs.map(async (song) => {
        try {
          const response = await fetch(
            `${process.env.urlMusic}/api/search/songs?query=${encodeURIComponent(
              song
            )}`
          );
          if (!response.ok) {
            console.error(`Error fetching song ${song}:`, response.statusText);
            return null;
          }
          const data = await response.json();
          if (data && data.data && Array.isArray(data.data.results)) {
            return data.data.results?.map((songData) => ({
              title: songData?.name ?? "Unknown Song",
              id: songData?.id,
              artist: songData?.artists?.primary?.[0]?.name ?? "Unknown Artist",
              album: songData?.album?.name ?? "Unknown Album",
              language: songData?.language ?? "Unknown Language",
              year: songData?.year ?? "Unknown Year",
              playCount: songData?.playCount ?? 0,
              image: songData?.image?.[2]?.url ?? placeholderImage,
              downloadUrls: songData?.downloadUrl ?? [],
            }));
          } else {
            console.warn(
              `Data for song ${song} is not in the expected format:`,
              data
            );
            return []; // Return an empty array if data is not as expected
          }
        } catch (error) {
          console.error("Error processing song:", error);
          return null;
        }
      })
    );

 const finalFilteredSongs = FilterSongs.flat().filter(
      (song) => song !== null && song.playCount >= 90000
    );
    const FilteredSongsForAI = [];
   
    finalFilteredSongs.forEach((song) =>
      FilteredSongsForAI.push({
        title: song.title,
        album: song.album,
        artist: song.artist,
        language: song.language,
        year: song.year,
        playCount: song.playCount,
      })
    );

const Filterprompt = `Return your output as valid JSON.
Determine the relevance of each song in the list based on the user's input.
- Return 1 if the song is relevant, 0 otherwise.
- If a song appears more than once, mark all duplicates as 0.
- The first element of "FilteredSongsForAI" is the user's input and should not be considered.
- Provide the result in a JSON object with the key "mySuggestion", containing an array of integers (0 or 1).

userInput: ${userInput}
Total Songs: ${FilteredSongsForAI.length}
API call Output: ${JSON.stringify(FilteredSongsForAI)}`;

    const filterModel = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: {
        role: "model",
        parts: [
          {
             text: "You are an expert music Selector. Only output valid JSON without markdown formatting or extra text.",
          },
        ],
      },
    });
    const filterResponse = await filterModel.generateContent(Filterprompt);
    let filterOutput = filterResponse.response.text();

    filterOutput = filterOutput
      .replace(/```(json)?\n/g, "")
      .replace(/```/g, "")
      .trim();

    let filterSuggestions;
    try {
      filterSuggestions = JSON.parse(filterOutput);
    } catch (parseError) {
      console.error("JSON Parse Error (Filtering):", parseError);
      return res
        .status(500)
        .json({ error: "Failed to parse filter response from AI" });
    }

    if (!filterSuggestions || !Array.isArray(filterSuggestions.mySuggestion)) {
      console.error("Invalid filter JSON structure:", filterSuggestions);
      return res.status(500).json({ error: "Unexpected filter JSON format" });
    }

    const mySuggestion = filterSuggestions.mySuggestion;
    if (mySuggestion.length !== finalFilteredSongs.length) {
      console.error(
        "Suggestion array length mismatch:",
        mySuggestion.length,
        finalFilteredSongs.length
      );
      return res
        .status(500)
        .json({ error: "Suggestion array length mismatch" });
    }

    const actuallyFinalFilteredSongs = finalFilteredSongs.filter(
      (song, index) => mySuggestion[index] === 1
    );

    res.json({ suggestedSongs: actuallyFinalFilteredSongs });
  } catch (error) {
    console.error("Gemini API error:", error);
    res.status(500).json({ error: "Error generating song suggestions" });
  }
});

// For local development, start the server.
// In production (Vercel), the exported app is used as a serverless function.
if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
  });
}

export default app;
