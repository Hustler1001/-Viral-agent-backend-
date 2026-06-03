/**
 * ViralAgent Backend Server
 * Handles video posting to TikTok, Instagram, YouTube, Facebook, Twitter/X
 * Deploy this to Railway.app or Render.com
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.get("/", (req, res) => {
  res.json({
    status: "✅ ViralAgent Backend Live",
    version: "1.0.0",
    platforms: ["tiktok", "instagram", "youtube", "facebook", "twitter"],
  });
});

app.post("/post/tiktok", upload.single("video"), async (req, res) => {
  try {
    const { caption, access_token } = req.body;
    const videoPath = req.file?.path;
    if (!access_token) return res.status(400).json({ error: "Missing TikTok access_token" });
    if (!videoPath) return res.status(400).json({ error: "Missing video file" });
    const initRes = await axios.post(
      "https://open.tiktokapis.com/v2/post/publish/video/init/",
      {
        post_info: { title: caption || "", privacy_level: "PUBLIC_TO_EVERYONE", disable_duet: false, disable_comment: false, disable_stitch: false, video_cover_timestamp_ms: 1000 },
        source_info: { source: "FILE_UPLOAD", video_size: fs.statSync(videoPath).size, chunk_size: fs.statSync(videoPath).size, total_chunk_count: 1 },
      },
      { headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json; charset=UTF-8" } }
    );
    const { publish_id, upload_url } = initRes.data.data;
    const videoBuffer = fs.readFileSync(videoPath);
    await axios.put(upload_url, videoBuffer, {
      headers: { "Content-Type": "video/mp4", "Content-Range": `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}` },
    });
    let status = "PROCESSING";
    let attempts = 0;
    while (status === "PROCESSING" && attempts < 10) {
      await sleep(3000);
      const statusRes = await axios.post(
        "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
        { publish_id },
        { headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" } }
      );
      status = statusRes.data.data.status;
      attempts++;
    }
    fs.unlinkSync(videoPath);
    res.json({ success: true, platform: "tiktok", publish_id, status });
  } catch (err) {
    cleanup(req.file?.path);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.post("/post/instagram", upload.single("video"), async (req, res) => {
  try {
    const { caption, access_token, instagram_account_id, video_url } = req.body;
    if (!access_token || !instagram_account_id) return res.status(400).json({ error: "Missing Instagram credentials" });
    if (!video_url) return res.status(400).json({ error: "Missing video_url" });
    const containerRes = await axios.post(
      `https://graph.facebook.com/v19.0/${instagram_account_id}/media`,
      null,
      { params: { media_type: "REELS", video_url, caption: caption || "", share_to_feed: true, access_token } }
    );
    const creationId = containerRes.data.id;
    let mediaStatus = "IN_PROGRESS";
    let attempts = 0;
    while (mediaStatus !== "FINISHED" && attempts < 15) {
      await sleep(4000);
      const statusRes = await axios.get(`https://graph.facebook.com/v19.0/${creationId}`, { params: { fields: "status_code", access_token } });
      mediaStatus = statusRes.data.status_code;
      if (mediaStatus === "ERROR") throw new Error("Instagram video processing failed");
      attempts++;
    }
    const publishRes = await axios.post(`https://graph.facebook.com/v19.0/${instagram_account_id}/media_publish`, null, { params: { creation_id: creationId, access_token } });
    if (req.file) cleanup(req.file.path);
    res.json({ success: true, platform: "instagram", media_id: publishRes.data.id });
  } catch (err) {
    cleanup(req.file?.path);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.post("/post/youtube", upload.single("video"), async (req, res) => {
  try {
    const { title, description, tags, client_id, client_secret, refresh_token } = req.body;
    const videoPath = req.file?.path;
    if (!client_id || !client_secret || !refresh_token) return res.status(400).json({ error: "Missing YouTube credentials" });
    if (!videoPath) return res.status(400).json({ error: "Missing video file" });
    const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
    oauth2Client.setCredentials({ refresh_token });
    const youtube = google.youtube({ version: "v3", auth: oauth2Client });
    const uploadRes = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title: title || "New Video", description: description || "", tags: tags ? tags.split(",").map(t => t.trim()) : [], categoryId: "22" },
        status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
      },
      media: { body: fs.createReadStream(videoPath) },
    });
    cleanup(videoPath);
    res.json({ success: true, platform: "youtube", video_id: uploadRes.data.id, url: `https://youtube.com/watch?v=${uploadRes.data.id}` });
  } catch (err) {
    cleanup(req.file?.path);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.post("/post/facebook", upload.single("video"), async (req, res) => {
  try {
    const { description, page_access_token, page_id } = req.body;
    const videoPath = req.file?.path;
    if (!page_access_token || !page_id) return res.status(400).json({ error: "Missing Facebook credentials" });
    if (!videoPath) return res.status(400).json({ error: "Missing video file" });
    const videoBuffer = fs.readFileSync(videoPath);
    const fileSize = videoBuffer.length;
    const startRes = await axios.post(`https://graph.facebook.com/v19.0/${page_id}/videos`, null, {
      params: { upload_phase: "start", file_size: fileSize, access_token: page_access_token },
    });
    const { upload_session_id, video_id } = startRes.data;
    let currentStart = parseInt(startRes.data.start_offset);
    let currentEnd = parseInt(startRes.data.end_offset);
    while (currentStart < fileSize) {
      const chunk = videoBuffer.slice(currentStart, currentEnd);
      const FormData = require("form-data");
      const form = new FormData();
      form.append("upload_phase", "transfer");
      form.append("upload_session_id", upload_session_id);
      form.append("start_offset", currentStart.toString());
      form.append("video_file_chunk", chunk, { filename: "chunk.mp4", contentType: "video/mp4" });
      form.append("access_token", page_access_token);
      const transferRes = await axios.post(`https://graph.facebook.com/v19.0/${page_id}/videos`, form, { headers: form.getHeaders() });
      currentStart = parseInt(transferRes.data.start_offset);
      currentEnd = parseInt(transferRes.data.end_offset);
    }
    await axios.post(`https://graph.facebook.com/v19.0/${page_id}/videos`, null, {
      params: { upload_phase: "finish", upload_session_id, description: description || "", access_token: page_access_token },
    });
    cleanup(videoPath);
    res.json({ success: true, platform: "facebook", video_id });
  } catch (err) {
    cleanup(req.file?.path);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.post("/post/twitter", upload.single("video"), async (req, res) => {
  try {
    const { tweet_text, api_key, api_secret, access_token, access_token_secret } = req.body;
    const videoPath = req.file?.path;
    if (!api_key || !api_secret || !access_token || !access_token_secret) return res.status(400).json({ error: "Missing Twitter credentials" });
    if (!videoPath) return res.status(400).json({ error: "Missing video file" });
    const { TwitterApi } = require("twitter-api-v2");
    const client = new TwitterApi({ appKey: api_key, appSecret: api_secret, accessToken: access_token, accessSecret: access_token_secret });
    const mediaId = await client.v1.uploadMedia(videoPath, { mimeType: "video/mp4", chunkLength: 5 * 1024 * 1024 });
    const tweet = await client.v2.tweet({ text: tweet_text || "", media: { media_ids: [mediaId] } });
    cleanup(videoPath);
    res.json({ success: true, platform: "twitter", tweet_id: tweet.data.id, url: `https://twitter.com/i/web/status/${tweet.data.id}` });
  } catch (err) {
    cleanup(req.file?.path);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.post("/upload/cloudinary", upload.single("video"), async (req, res) => {
  try {
    const { cloudinary_cloud_name, cloudinary_api_key, cloudinary_api_secret } = req.body;
    const videoPath = req.file?.path;
    if (!cloudinary_cloud_name || !cloudinary_api_key || !cloudinary_api_secret) return res.status(400).json({ error: "Missing Cloudinary credentials" });
    const cloudinary = require("cloudinary").v2;
    cloudinary.config({ cloud_name: cloudinary_cloud_name, api_key: cloudinary_api_key, api_secret: cloudinary_api_secret });
    const result = await cloudinary.uploader.upload(videoPath, { resource_type: "video", folder: "viral-agent" });
    cleanup(videoPath);
    res.json({ success: true, url: result.secure_url, public_id: result.public_id });
  } catch (err) {
    cleanup(req.file?.path);
    res.status(500).json({ error: err.message });
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function cleanup(filePath) {
  if (filePath && fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch {} }
}

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

app.listen(PORT, () => {
  console.log(`🚀 ViralAgent backend running on port ${PORT}`);
});
