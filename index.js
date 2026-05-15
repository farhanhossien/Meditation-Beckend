require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const supabase = require("./supabase");
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "stillness_jwt_secret_key_2024";

const app = express();

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Backend running 🚀");
});

// --- AUTH ROUTES ---

app.post("/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) {
      return res.status(400).json({ message: "Email, username & password required" });
    }

    const { data: existing } = await supabase.from("users").select("id").eq("email", email).maybeSingle();
    if (existing) {
      return res.status(400).json({ message: "An account with this email already exists." });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase.from("users").insert([{ email, username, password_hash }]).select();
    
    if (error) return res.status(400).json({ error: error.message });
    
    const user = data[0];
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    
    res.json({ message: "User registered successfully", token, user: { id: user.id, email: user.email, username: user.username } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const { data: user, error } = await supabase.from("users").select("*").eq("email", email).maybeSingle();
    if (error || !user) return res.status(400).json({ message: "User not found" });

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

    res.json({ 
      message: "Login success", 
      token,
      user: { id: user.id, email: user.email, username: user.username } 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/verify-token", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ valid: false });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, user: decoded });
  } catch {
    res.status(401).json({ valid: false });
  }
});

// --- AI PROXY ROUTES ---

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function callClaude(systemPrompt, userMessage) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("Anthropic API Key not configured in .env");
  }

  const response = await axios.post("https://api.anthropic.com/v1/messages", {
    model: "claude-3-5-sonnet-20240620",
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }]
  }, {
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    }
  });

  return response.data.content.map(c => c.text).join("");
}

app.post("/ai/mood-guide", async (req, res) => {
  try {
    const { mood, note } = req.body;
    const systemPrompt = `You are a compassionate meditation guide. Respond ONLY with valid JSON. Return: {"sessionTitle":"short evocative title","duration":"X min","intro":"2-3 empathetic sentences","steps":[{"num":"01","title":"step","desc":"desc"},{"num":"02","title":"step","desc":"desc"},{"num":"03","title":"step","desc":"desc"}],"affirmation":"one closing sentence","recommendedSound":"one of: rain,ocean,forest,fire,night,wind,stream,white"}`;
    const userMessage = `Mood: ${mood || 'general'}. ${note ? 'User says: "' + note + '"' : ''}`;
    
    const result = await callClaude(systemPrompt, userMessage);
    res.json(JSON.parse(result));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI Service Error" });
  }
});

app.post("/ai/journal-insight", async (req, res) => {
  try {
    const { text } = req.body;
    const systemPrompt = "You are a compassionate mindfulness guide. Read the user's meditation journal entry and offer a brief, warm, poetic insight (2-3 sentences) that helps them see their experience more clearly. No lists. No preamble. Just the insight.";
    
    const result = await callClaude(systemPrompt, text);
    res.json({ insight: result });
  } catch (err) {
    res.status(500).json({ error: "AI Service Error" });
  }
});

app.post("/ai/focus-tip", async (req, res) => {
  try {
    const { intention } = req.body;
    const systemPrompt = "You are a mindfulness coach. Respond ONLY with a single beautiful, brief (2-3 sentence) mindful break tip. No JSON, no preamble, just the tip itself in plain text. Make it poetic, grounding, and specific to the context if given.";
    const userMessage = `Give a mindful break tip.${intention ? ' The person is working on: "' + intention + '"' : ''}`;
    
    const result = await callClaude(systemPrompt, userMessage);
    res.json({ tip: result });
  } catch (err) {
    res.status(500).json({ error: "AI Service Error" });
  }
});

// --- DATA ROUTES ---

app.post("/session", async (req, res) => {
  try {
    const { user_id, duration_seconds, session_type } = req.body;
    if (!user_id) return res.status(400).json({ message: "user_id required" });
    const today = new Date().toISOString().split("T")[0];
    const { error: sessionError } = await supabase.from("meditation_sessions").insert([{ user_id, duration_seconds, session_type, started_at: new Date() }]);
    if (sessionError) return res.status(400).json({ error: sessionError.message });
    const { data: streak } = await supabase.from("streaks").select("*").eq("user_id", user_id).maybeSingle();
    if (!streak) {
      await supabase.from("streaks").insert([{ user_id, current_streak: 1, longest_streak: 1, last_meditated_on: today }]);
      return res.json({ message: "Session saved + streak started 🔥", current_streak: 1 });
    }
    const lastDate = streak.last_meditated_on;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yDate = yesterday.toISOString().split("T")[0];
    let newStreak = 1;
    if (lastDate === today) newStreak = streak.current_streak;
    else if (lastDate === yDate) newStreak = streak.current_streak + 1;
    await supabase.from("streaks").update({ current_streak: newStreak, longest_streak: Math.max(streak.longest_streak, newStreak), last_meditated_on: today }).eq("user_id", user_id);
    res.json({ message: "Session + streak updated 🔥", current_streak: newStreak });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/stats/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;
    const { count } = await supabase.from("meditation_sessions").select("*", { count: "exact", head: true }).eq("user_id", user_id);
    const { data: sessions } = await supabase.from("meditation_sessions").select("duration_seconds").eq("user_id", user_id);
    const total_time = sessions?.reduce((sum, s) => sum + s.duration_seconds, 0) || 0;
    const { data: streak } = await supabase.from("streaks").select("*").eq("user_id", user_id).maybeSingle();
    res.json({ total_sessions: count || 0, total_time, current_streak: streak?.current_streak || 0, longest_streak: streak?.longest_streak || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => { console.log(`Server running on ${PORT} 🚀`); });