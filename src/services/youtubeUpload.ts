import { google } from "googleapis";
import type { Credentials } from "google-auth-library";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";

export interface YouTubeUploadOptions {
  title: string;
  description: string;
  tags?: string[];
  categoryId?: string;
  privacyStatus?: "private" | "public" | "unlisted";
  thumbnailPath?: string;
}

export interface YouTubeUploadResult {
  videoId: string;
  videoUrl: string;
  embedUrl: string;
  watchUrl: string;
  thumbnailUrl: string;
}

export class YouTubeUploadService {
  private youtube;
  private oauth2Client;

  constructor() {
    // Initialize OAuth2 client
    this.oauth2Client = new google.auth.OAuth2(
      process.env.YOUTUBE_CLIENT_ID,
      process.env.YOUTUBE_CLIENT_SECRET,
      process.env.YOUTUBE_REDIRECT_URI ||
        "http://localhost:3000/auth/youtube/callback"
    );

    // Set credentials - these should be stored securely in your database
    // Fix for exact optional property types
    const credentials: Credentials = {};

    if (process.env.YOUTUBE_ACCESS_TOKEN) {
      credentials.access_token = process.env.YOUTUBE_ACCESS_TOKEN;
    }

    if (process.env.YOUTUBE_REFRESH_TOKEN) {
      credentials.refresh_token = process.env.YOUTUBE_REFRESH_TOKEN;
    }

    this.oauth2Client.setCredentials(credentials);

    // Initialize YouTube API
    this.youtube = google.youtube({
      version: "v3",
      auth: this.oauth2Client,
    });

    this.oauth2Client.on("tokens", (tokens) => {
      if (tokens.refresh_token) {
        // Store the new refresh token securely
        console.log("New refresh token received:", tokens.refresh_token);
      }
      if (tokens.access_token) {
        // Store the new access token
        console.log("Access token refreshed");
      }
    });
  }

  /**
   * Upload video to YouTube
   */
  async uploadVideo(
    videoFilePath: string,
    options: YouTubeUploadOptions
  ): Promise<YouTubeUploadResult> {
    try {
      console.log(`[YouTube] Starting upload: ${options.title}`);

      // Verify file exists and get file size
      const stats = await fs.stat(videoFilePath);
      console.log(
        `[YouTube] File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`
      );

      // Create readable stream from file
      const fileStream = await fs.readFile(videoFilePath);
      const videoStream = Readable.from(fileStream);

      // Upload video
      const uploadResponse = await this.youtube.videos.insert({
        part: ["snippet", "status"],
        requestBody: {
          snippet: {
            title: options.title,
            description: options.description,
            tags: options.tags || [],
            categoryId: options.categoryId || "27", // Education category
            defaultLanguage: "en",
            defaultAudioLanguage: "en",
          },
          status: {
            privacyStatus: options.privacyStatus || "unlisted",
            embeddable: true,
            license: "youtube",
          },
        },
        media: {
          body: videoStream,
        },
      });

      const videoId = uploadResponse.data.id;
      if (!videoId) {
        throw new Error("Video upload failed - no video ID returned");
      }

      console.log(`[YouTube] Upload successful! Video ID: ${videoId}`);

      // Upload thumbnail if provided
      if (options.thumbnailPath) {
        await this.uploadThumbnail(videoId, options.thumbnailPath);
      }

      // Generate URLs
      const result: YouTubeUploadResult = {
        videoId,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        embedUrl: `https://www.youtube.com/embed/${videoId}`,
        watchUrl: `https://youtu.be/${videoId}`,
        thumbnailUrl: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      };

      console.log(`[YouTube] Video available at: ${result.watchUrl}`);
      return result;
    } catch (error: any) {
      console.error("[YouTube] Upload failed:", error);

      // Handle common errors
      if (error.code === 401) {
        throw new Error(
          "YouTube authentication failed - refresh tokens may be expired"
        );
      } else if (error.code === 403) {
        const message = error.message || "";
        if (message.includes("quota")) {
          throw new Error("YouTube API quota exceeded - try again later");
        } else if (message.includes("upload")) {
          throw new Error(
            "YouTube upload limit reached - check channel limits"
          );
        } else {
          throw new Error("YouTube API access forbidden - check permissions");
        }
      } else if (error.code === 400) {
        throw new Error(`YouTube API bad request: ${error.message}`);
      } else {
        throw new Error(`YouTube upload error: ${error.message}`);
      }
    }
  }

  /**
   * Upload custom thumbnail
   */
  async uploadThumbnail(videoId: string, thumbnailPath: string): Promise<void> {
    try {
      console.log(`[YouTube] Uploading thumbnail for video ${videoId}`);

      const thumbnailData = await fs.readFile(thumbnailPath);
      const thumbnailStream = Readable.from(thumbnailData);

      await this.youtube.thumbnails.set({
        videoId,
        media: {
          body: thumbnailStream,
        },
      });

      console.log(`[YouTube] Thumbnail uploaded successfully`);
    } catch (error: any) {
      console.error("[YouTube] Thumbnail upload failed:", error.message);
      // Don't throw - thumbnail is optional
    }
  }

  /**
   * Update video details
   */
  async updateVideo(
    videoId: string,
    updates: Partial<YouTubeUploadOptions>
  ): Promise<void> {
    try {
      await this.youtube.videos.update({
        part: ["snippet", "status"],
        requestBody: {
          id: videoId,
          snippet: {
            ...(updates.title && { title: updates.title }),
            ...(updates.description && { description: updates.description }),
            ...(updates.tags && { tags: updates.tags }),
            ...(updates.categoryId && { categoryId: updates.categoryId }),
          },
          status: {
            ...(updates.privacyStatus && {
              privacyStatus: updates.privacyStatus,
            }),
          },
        },
      });

      console.log(`[YouTube] Video ${videoId} updated successfully`);
    } catch (error: any) {
      throw new Error(`Failed to update YouTube video: ${error.message}`);
    }
  }

  /**
   * Delete video from YouTube
   */
  async deleteVideo(videoId: string): Promise<void> {
    try {
      await this.youtube.videos.delete({
        id: videoId,
      });
      console.log(`[YouTube] Video ${videoId} deleted successfully`);
    } catch (error: any) {
      throw new Error(`Failed to delete YouTube video: ${error.message}`);
    }
  }

  /**
   * Get video details
   */
  async getVideoDetails(videoId: string) {
    try {
      const response = await this.youtube.videos.list({
        part: ["snippet", "status", "statistics"],
        id: [videoId],
      });

      return response.data.items?.[0] || null;
    } catch (error: any) {
      throw new Error(`Failed to get YouTube video details: ${error.message}`);
    }
  }

  /**
   * Check if video processing is complete
   */
  async checkVideoStatus(videoId: string): Promise<{
    uploadStatus: string;
    processingStatus: string;
    privacyStatus: string;
  }> {
    try {
      const response = await this.youtube.videos.list({
        part: ["status", "processingDetails"],
        id: [videoId],
      });

      const video = response.data.items?.[0];
      if (!video) {
        throw new Error("Video not found");
      }

      return {
        uploadStatus: video.status?.uploadStatus || "unknown",
        processingStatus:
          video.processingDetails?.processingStatus || "unknown",
        privacyStatus: video.status?.privacyStatus || "unknown",
      };
    } catch (error: any) {
      throw new Error(`Failed to check YouTube video status: ${error.message}`);
    }
  }

  /**
   * Generate OAuth2 authorization URL (for initial setup)
   */
  getAuthUrl(): string {
    const scopes = [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube",
    ];

    return this.oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: scopes,
      prompt: "consent", // Force consent screen to get refresh token
    });
  }

  /**
   * Exchange authorization code for tokens (for initial setup)
   */
  async getTokensFromCode(code: string): Promise<Credentials> {
    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);
    return tokens;
  }
}
