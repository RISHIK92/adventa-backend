import { google } from "googleapis";
import type { Credentials } from "google-auth-library";
import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import path from "path";
import { EventEmitter } from "events";

export interface YouTubeUploadOptions {
  title: string;
  description: string;
  tags?: string[];
  categoryId?: string;
  privacyStatus?: "private" | "public" | "unlisted";
  thumbnailPath?: string;
  onProgress?: (progress: UploadProgress) => void;
}

export interface YouTubeUploadResult {
  videoId: string;
  videoUrl: string;
  embedUrl: string;
  watchUrl: string;
  thumbnailUrl: string;
}

export interface UploadProgress {
  bytesUploaded: number;
  totalBytes: number;
  percentage: number;
  stage: "validating" | "uploading" | "processing" | "thumbnail" | "completed";
}

export interface VideoValidationResult {
  isValid: boolean;
  errors: string[];
  fileSize: number;
  duration?: number;
}

// Token storage interface for dependency injection
export interface TokenStorage {
  getTokens(): Promise<Credentials | null>;
  saveTokens(tokens: Credentials): Promise<void>;
}

// Default file-based token storage
export class FileTokenStorage implements TokenStorage {
  constructor(private tokenFilePath: string = "./youtube-tokens.json") {}

  async getTokens(): Promise<Credentials | null> {
    try {
      const data = await fs.readFile(this.tokenFilePath, "utf-8");
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  async saveTokens(tokens: Credentials): Promise<void> {
    try {
      await fs.writeFile(this.tokenFilePath, JSON.stringify(tokens, null, 2));
    } catch (error) {
      console.error(
        "[YouTube::FileTokenStorage] [Error] Failed to save tokens:",
        error
      );
    }
  }
}

export class YouTubeUploadService extends EventEmitter {
  private youtube: any;
  private oauth2Client: any;
  private tokenRefreshPromise: Promise<void> | null = null;
  private readonly tokenStorage: TokenStorage;
  private readonly maxRetries: number = 3;
  private readonly baseRetryDelay: number = 1000;

  // YouTube API limits
  private readonly MAX_FILE_SIZE = 128 * 1024 * 1024 * 1024; // 128GB
  private readonly MAX_TITLE_LENGTH = 100;
  private readonly MAX_DESCRIPTION_LENGTH = 5000;
  private readonly MAX_TAGS = 500;
  private readonly SUPPORTED_FORMATS = [
    ".mov",
    ".mpeg4",
    ".mp4",
    ".avi",
    ".wmv",
    ".mpegps",
    ".flv",
    ".3gpp",
    ".webm",
  ];

  private constructor(tokenStorage?: TokenStorage) {
    super();
    console.log(
      "[YouTube::constructor] [Info] Initializing YouTubeUploadService..."
    );
    try {
      this.tokenStorage = tokenStorage || new FileTokenStorage();
      this.validateEnvironmentVariables();
      this.initializeOAuthClient();
      this.initializeYouTubeAPI();
      this.setupTokenHandling();
    } catch (error) {
      console.error(
        "[YouTube::constructor] [Fatal] Initialization failed:",
        error
      );
      throw error;
    }
  }

  /**
   * Static factory method to create and initialize the service
   */
  static async create(
    tokenStorage?: TokenStorage
  ): Promise<YouTubeUploadService> {
    const service = new YouTubeUploadService(tokenStorage);
    await service.initialize();
    return service;
  }

  private validateEnvironmentVariables(): void {
    console.log(
      "[YouTube::validateEnvironmentVariables] [Info] Validating environment variables..."
    );
    const required = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"];
    const missing = required.filter(
      (key) => !process.env[key] || process.env[key]!.trim() === ""
    );

    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}\n` +
          `Please set these in your .env file or environment:\n` +
          `YOUTUBE_CLIENT_ID=your_client_id\n` +
          `YOUTUBE_CLIENT_SECRET=your_client_secret\n` +
          `YOUTUBE_REDIRECT_URI=http://localhost:3000/auth/youtube/callback (optional)\n` +
          `YOUTUBE_REFRESH_TOKEN=your_refresh_token (optional, for initial auth)`
      );
    }

    const clientId = process.env.YOUTUBE_CLIENT_ID!;
    if (
      !clientId.includes(".") ||
      !clientId.endsWith(".googleusercontent.com")
    ) {
      console.warn(
        "[YouTube::validateEnvironmentVariables] [Warning] Client ID format seems invalid. " +
          "Expected format: xxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com"
      );
    }

    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET!;
    if (clientSecret.length < 20) {
      console.warn(
        "[YouTube::validateEnvironmentVariables] [Warning] Client secret seems too short. " +
          "Expected a longer string from Google Console."
      );
    }

    console.log(
      "[YouTube::validateEnvironmentVariables] [Success] Environment variables validated successfully"
    );
  }

  private initializeOAuthClient(): void {
    console.log(
      "[YouTube::initializeOAuthClient] [Info] Initializing OAuth2 client..."
    );
    console.log("--- Initializing YouTubeUploadService ---");
    console.log(
      "YOUTUBE_CLIENT_ID:",
      process.env.YOUTUBE_CLIENT_ID ? "Loaded" : "MISSING!"
    );
    console.log(
      "YOUTUBE_CLIENT_SECRET:",
      process.env.YOUTUBE_CLIENT_SECRET ? "Loaded" : "MISSING!"
    );
    console.log(
      "YOUTUBE_ACCESS_TOKEN:",
      process.env.YOUTUBE_ACCESS_TOKEN
        ? process.env.YOUTUBE_ACCESS_TOKEN
        : "MISSING!"
    );
    console.log(
      "YOUTUBE_REFRESH_TOKEN:",
      process.env.YOUTUBE_REFRESH_TOKEN
        ? process.env.YOUTUBE_REFRESH_TOKEN
        : "MISSING!"
    );
    try {
      this.oauth2Client = new google.auth.OAuth2(
        process.env.YOUTUBE_CLIENT_ID!,
        process.env.YOUTUBE_CLIENT_SECRET!,
        process.env.YOUTUBE_REDIRECT_URI ||
          "http://localhost:3000/auth/youtube/callback"
      );
      console.log(
        "[YouTube::initializeOAuthClient] [Success] OAuth2 client initialized"
      );
    } catch (error) {
      console.error(
        "[YouTube::initializeOAuthClient] [Error] Failed to initialize OAuth2 client:",
        error
      );
    }
  }

  private initializeYouTubeAPI(): void {
    console.log(
      "[YouTube::initializeYouTubeAPI] [Info] Initializing YouTube API client..."
    );
    try {
      this.youtube = google.youtube({
        version: "v3",
        auth: this.oauth2Client,
      });
      console.log(
        "[YouTube::initializeYouTubeAPI] [Success] YouTube API client initialized"
      );
    } catch (error) {
      console.error(
        "[YouTube::initializeYouTubeAPI] [Error] Failed to initialize YouTube API:",
        error
      );
      throw new Error("Failed to initialize YouTube API client");
    }
  }

  private setupTokenHandling(): void {
    console.log(
      "[YouTube::setupTokenHandling] [Info] Setting up token event handlers..."
    );
    this.oauth2Client.on("tokens", async (tokens: any) => {
      try {
        if (tokens.refresh_token) {
          console.log(
            "[YouTube::setupTokenHandling] [Info] New refresh token received."
          );
        }
        if (tokens.access_token) {
          console.log(
            "[YouTube::setupTokenHandling] [Info] Access token refreshed."
          );
        }
        await this.tokenStorage.saveTokens(tokens);
        this.emit("tokensUpdated", tokens);
      } catch (error) {
        console.error(
          "[YouTube::setupTokenHandling] [Error] Failed to save tokens:",
          error
        );
        this.emit("error", new Error("Failed to save authentication tokens"));
      }
    });
  }

  private async loadStoredTokens(): Promise<void> {
    console.log(
      "[YouTube::loadStoredTokens] [Info] Loading authentication tokens..."
    );
    try {
      const storedTokens = await this.tokenStorage.getTokens();
      if (storedTokens) {
        console.log(
          "[YouTube::loadStoredTokens] [Info] Found stored tokens, validating..."
        );
        if (this.isValidTokenStructure(storedTokens)) {
          this.oauth2Client.setCredentials(storedTokens);
          console.log(
            "[YouTube::loadStoredTokens] [Success] Loaded stored tokens successfully."
          );
          if (await this.testTokenValidity()) {
            console.log(
              "[YouTube::loadStoredTokens] [Success] Stored tokens are valid."
            );
            return;
          } else {
            console.warn(
              "[YouTube::loadStoredTokens] [Warning] Stored tokens are invalid or expired, attempting refresh..."
            );
            await this.ensureAccessToken();
          }
        } else {
          console.warn(
            "[YouTube::loadStoredTokens] [Warning] Stored tokens have an invalid structure."
          );
        }
      }

      const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
      if (refreshToken && refreshToken.trim() !== "") {
        console.log(
          "[YouTube::loadStoredTokens] [Info] Using refresh token from environment variable."
        );
        if (this.isValidRefreshToken(refreshToken)) {
          this.oauth2Client.setCredentials({
            refresh_token: refreshToken.trim(),
          });
          try {
            await this.ensureAccessToken();
            console.log(
              "[YouTube::loadStoredTokens] [Success] Successfully authenticated using environment refresh token."
            );
            return;
          } catch (error) {
            console.error(
              "[YouTube::loadStoredTokens] [Error] Failed to use refresh token from environment:",
              error
            );
          }
        } else {
          console.warn(
            "[YouTube::loadStoredTokens] [Warning] Invalid refresh token format in environment variable."
          );
        }
      }

      console.warn(
        "[YouTube::loadStoredTokens] [Warning] No valid authentication tokens found. Please authenticate first."
      );
    } catch (error) {
      console.error(
        "[YouTube::loadStoredTokens] [Error] Failed to load tokens:",
        error
      );
      throw new Error(
        `Authentication initialization failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  private isValidTokenStructure(tokens: any): boolean {
    if (!tokens || typeof tokens !== "object") {
      return false;
    }
    return !!(tokens.refresh_token || tokens.access_token);
  }

  private isValidRefreshToken(token: string): boolean {
    return token.length > 50;
  }

  private async testTokenValidity(): Promise<boolean> {
    try {
      await this.oauth2Client.getAccessToken();
      return true;
    } catch (error) {
      return false;
    }
  }

  private async ensureAccessToken(): Promise<void> {
    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }

    const tokens = this.oauth2Client.credentials;
    if (!tokens.access_token && !tokens.refresh_token) {
      throw new Error(
        "No authentication tokens available. Please authenticate first."
      );
    }

    if (
      tokens.access_token &&
      tokens.expiry_date &&
      tokens.expiry_date > Date.now() + 300000
    ) {
      return;
    }

    this.tokenRefreshPromise = this._refreshToken();
    try {
      await this.tokenRefreshPromise;
    } finally {
      this.tokenRefreshPromise = null;
    }
  }

  private async _refreshToken(): Promise<void> {
    console.log("[YouTube::_refreshToken] [Info] Refreshing access token...");
    try {
      const tokens = this.oauth2Client.credentials;
      if (!tokens.refresh_token) {
      }

      const { credentials } = await this.oauth2Client.refreshAccessToken();
      this.oauth2Client.setCredentials(credentials);
      console.log(
        "[YouTube::_refreshToken] [Success] Access token refreshed successfully."
      );

      await this.tokenStorage.saveTokens(this.oauth2Client.credentials);
    } catch (error: any) {
      console.error(
        `[YouTube::_refreshToken] [Error] Token refresh failed with code ${error.code}:`,
        error.message
      );
      if (error.code === 400 && error.message?.includes("invalid_grant")) {
      } else if (error.code === 401) {
      } else {
      }
    }
  }

  private async validateVideoFile(
    videoFilePath: string
  ): Promise<VideoValidationResult> {
    const errors: string[] = [];
    let fileSize = 0;

    try {
      const stats = await fs.stat(videoFilePath);
      fileSize = stats.size;

      if (fileSize === 0) errors.push("File is empty");
      else if (fileSize > this.MAX_FILE_SIZE) {
        errors.push(
          `File size (${this.formatBytes(
            fileSize
          )}) exceeds YouTube limit of ${this.formatBytes(this.MAX_FILE_SIZE)}`
        );
      }

      const ext = path.extname(videoFilePath).toLowerCase();
      if (!this.SUPPORTED_FORMATS.includes(ext)) {
        errors.push(
          `Unsupported file format: ${ext}. Supported formats: ${this.SUPPORTED_FORMATS.join(
            ", "
          )}`
        );
      }

      await fs.access(videoFilePath, fs.constants.R_OK);
    } catch (error: any) {
      if (error.code === "ENOENT")
        errors.push(`File does not exist at path: ${videoFilePath}`);
      else if (error.code === "EACCES")
        errors.push(`File is not readable at path: ${videoFilePath}`);
      else errors.push(`File validation error: ${error.message}`);
    }

    return { isValid: errors.length === 0, errors, fileSize };
  }

  private validateUploadOptions(options: YouTubeUploadOptions): string[] {
    const errors: string[] = [];

    if (!options.title?.trim()) {
      errors.push("Title is required");
    } else if (options.title.length > this.MAX_TITLE_LENGTH) {
      errors.push(
        `Title exceeds maximum length of ${this.MAX_TITLE_LENGTH} characters`
      );
    }

    if (
      options.description &&
      options.description.length > this.MAX_DESCRIPTION_LENGTH
    ) {
      errors.push(
        `Description exceeds maximum length of ${this.MAX_DESCRIPTION_LENGTH} characters`
      );
    }

    if (options.tags && options.tags.length > this.MAX_TAGS) {
      errors.push(
        `Number of tags (${options.tags.length}) exceeds maximum of ${this.MAX_TAGS}`
      );
    }

    if (
      options.privacyStatus &&
      !["private", "public", "unlisted"].includes(options.privacyStatus)
    ) {
      errors.push(
        "Invalid privacy status. Must be private, public, or unlisted"
      );
    }

    if (
      options.categoryId &&
      (!/^\d+$/.test(options.categoryId) || parseInt(options.categoryId) < 1)
    ) {
      errors.push("Invalid category ID. Must be a positive integer");
    }

    return errors;
  }

  private async validateThumbnail(thumbnailPath: string): Promise<string[]> {
    const errors: string[] = [];
    const supportedFormats = [".jpg", ".jpeg", ".gif", ".png"];
    const maxSize = 2 * 1024 * 1024; // 2MB

    try {
      const stats = await fs.stat(thumbnailPath);
      const ext = path.extname(thumbnailPath).toLowerCase();

      if (!supportedFormats.includes(ext)) {
        errors.push(
          `Unsupported thumbnail format: ${ext}. Supported: ${supportedFormats.join(
            ", "
          )}`
        );
      }

      if (stats.size > maxSize) {
        errors.push(
          `Thumbnail size (${this.formatBytes(stats.size)}) exceeds 2MB limit`
        );
      }

      await fs.access(thumbnailPath, fs.constants.R_OK);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        errors.push("Thumbnail file does not exist");
      } else if (error.code === "EACCES") {
        errors.push("Thumbnail file is not readable");
      } else {
        errors.push(`Thumbnail validation error: ${error.message}`);
      }
    }

    return errors;
  }

  private async retryOperation<T>(
    operation: () => Promise<T>,
    operationName: string,
    retries: number = this.maxRetries
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        if (attempt > retries) {
          console.error(
            `[YouTube::retryOperation] [Error] ${operationName} failed after ${retries} retries.`
          );
          break;
        }

        if (
          error.code === 401 ||
          error.code === 400 ||
          (error.code === 403 && !error.message?.includes("quota"))
        ) {
          console.error(
            `[YouTube::retryOperation] [Error] Non-retriable error for ${operationName}. Aborting.`
          );
          break;
        }

        const delay = this.baseRetryDelay * Math.pow(2, attempt - 1);
        console.log(
          `[YouTube::retryOperation] [Warning] ${operationName} failed (attempt ${attempt}), retrying in ${delay}ms. Error:`,
          error.message
        );
        await this.delay(delay);
      }
    }

    throw lastError!;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  /**
   * Initialize the service by loading stored tokens
   */
  async initialize(): Promise<void> {
    console.log("[YouTube::initialize] [Info] Initializing service...");
    await this.loadStoredTokens();
    console.log("[YouTube::initialize] [Success] Service initialized.");
  }

  /**
   * Upload video to YouTube with comprehensive error handling and validation
   */
  async uploadVideo(
    videoFilePath: string,
    options: YouTubeUploadOptions
  ): Promise<YouTubeUploadResult> {
    const emitProgress = (progress: Partial<UploadProgress>) => {
      options.onProgress?.(progress as UploadProgress);
      this.emit("progress", progress);
    };

    try {
      console.log(
        `[YouTube::uploadVideo] [Info] Starting upload process for: ${videoFilePath}`
      );
      emitProgress({
        stage: "validating",
        percentage: 0,
        bytesUploaded: 0,
        totalBytes: 0,
      });

      const fileValidation = await this.validateVideoFile(videoFilePath);
      if (!fileValidation.isValid) {
        throw new Error(
          `Video validation failed: ${fileValidation.errors.join(", ")}`
        );
      }

      const optionErrors = this.validateUploadOptions(options);
      if (optionErrors.length > 0) {
        throw new Error(
          `Upload options validation failed: ${optionErrors.join(", ")}`
        );
      }

      if (options.thumbnailPath) {
        const thumbnailErrors = await this.validateThumbnail(
          options.thumbnailPath
        );
        if (thumbnailErrors.length > 0) {
          throw new Error(
            `Thumbnail validation failed: ${thumbnailErrors.join(", ")}`
          );
        }
      }

      await this.ensureAccessToken();
      console.log(
        `[YouTube::uploadVideo] [Info] Starting upload for title: "${options.title}"`
      );

      emitProgress({
        stage: "uploading",
        percentage: 0,
        bytesUploaded: 0,
        totalBytes: fileValidation.fileSize,
      });
      const videoStream = createReadStream(videoFilePath);
      let bytesUploaded = 0;

      videoStream.on("data", (chunk) => {
        bytesUploaded += chunk.length;
        const percentage = Math.round(
          (bytesUploaded / fileValidation.fileSize) * 100
        );
        emitProgress({
          stage: "uploading",
          percentage,
          bytesUploaded,
          totalBytes: fileValidation.fileSize,
        });
      });
      videoStream.on("error", (error) => {
        console.error(
          "[YouTube::uploadVideo] [Error] Video stream error:",
          error
        );
        this.emit("error", error);
      });

      const uploadResponse: any = await this.retryOperation(
        () =>
          this.youtube.videos.insert({
            part: ["snippet", "status"],
            requestBody: {
              snippet: {
                title: options.title.trim(),
                description: options.description?.trim() || "",
                tags: options.tags || [],
                categoryId: options.categoryId || "22",
                defaultLanguage: "en",
                defaultAudioLanguage: "en",
              },
              status: {
                privacyStatus: options.privacyStatus || "unlisted",
                embeddable: true,
                license: "youtube",
                selfDeclaredMadeForKids: false,
              },
            },
            media: { body: videoStream },
          }),
        "Video upload"
      );

      const videoId = uploadResponse.data.id;
      if (!videoId) {
        throw new Error("Video upload failed - no video ID returned from API.");
      }

      console.log(
        `[YouTube::uploadVideo] [Success] Upload successful! Video ID: ${videoId}`
      );
      emitProgress({
        stage: "processing",
        percentage: 90,
        bytesUploaded: fileValidation.fileSize,
        totalBytes: fileValidation.fileSize,
      });

      if (options.thumbnailPath) {
        await this.delay(2000);
        await this.uploadThumbnailWithRetry(videoId, options.thumbnailPath);
        emitProgress({
          stage: "thumbnail",
          percentage: 95,
          bytesUploaded: fileValidation.fileSize,
          totalBytes: fileValidation.fileSize,
        });
      }

      const result: YouTubeUploadResult = {
        videoId,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        embedUrl: `https://www.youtube.com/embed/${videoId}`,
        watchUrl: `https://youtu.be/${videoId}`,
        thumbnailUrl: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      };

      emitProgress({
        stage: "completed",
        percentage: 100,
        bytesUploaded: fileValidation.fileSize,
        totalBytes: fileValidation.fileSize,
      });
      console.log(
        `[YouTube::uploadVideo] [Success] Video available at: ${result.watchUrl}`
      );
      this.emit("uploadComplete", result);
      return result;
    } catch (error: any) {
      console.error(
        `[YouTube::uploadVideo] [Fatal] Upload failed with code ${error.code}:`,
        error
      );
      this.emit("error", error);

      if (error.code === 401)
        throw new Error(
          "YouTube authentication failed - please re-authenticate."
        );
      else if (error.code === 403) {
        const message = error.message || "";
        if (message.includes("quota"))
          throw new Error(
            "YouTube API quota exceeded - try again later or request a quota increase."
          );
        else if (message.includes("upload"))
          throw new Error(
            "YouTube upload limit reached - check your channel's upload limits."
          );
        else throw new Error(`YouTube API access forbidden: ${error.message}`);
      } else if (error.code === 400)
        throw new Error(`Invalid upload request: ${error.message}`);
      else throw new Error(`YouTube upload error: ${error.message}`);
    }
  }

  /**
   * Upload custom thumbnail with retry logic
   */
  private async uploadThumbnailWithRetry(
    videoId: string,
    thumbnailPath: string
  ): Promise<void> {
    console.log(
      `[YouTube::uploadThumbnailWithRetry] [Info] Starting thumbnail upload for video ID: ${videoId}`
    );
    await this.retryOperation(async () => {
      await this.uploadThumbnail(videoId, thumbnailPath);
    }, "Thumbnail upload");
  }

  /**
   * Upload custom thumbnail
   */
  async uploadThumbnail(videoId: string, thumbnailPath: string): Promise<void> {
    try {
      console.log(
        `[YouTube::uploadThumbnail] [Info] Uploading thumbnail for video ${videoId} from ${thumbnailPath}`
      );
      const thumbnailStream = createReadStream(thumbnailPath);
      thumbnailStream.on("error", (error) => {
        console.error(
          "[YouTube::uploadThumbnail] [Error] Thumbnail stream error:",
          error
        );
      });

      await this.youtube.thumbnails.set({
        videoId,
        media: { body: thumbnailStream },
      });

      console.log(
        `[YouTube::uploadThumbnail] [Success] Thumbnail uploaded successfully for video ${videoId}`
      );
    } catch (error: any) {
      console.error(
        `[YouTube::uploadThumbnail] [Error] Thumbnail upload failed for video ${videoId}:`,
        error.message
      );
      throw new Error(`Failed to upload thumbnail: ${error.message}`);
    }
  }

  /**
   * Update video details with validation
   */
  async updateVideo(
    videoId: string,
    updates: Partial<YouTubeUploadOptions>
  ): Promise<void> {
    try {
      if (!videoId?.trim()) {
        throw new Error("Video ID is required");
      }

      const optionErrors = this.validateUploadOptions(
        updates as YouTubeUploadOptions
      );
      if (optionErrors.length > 0) {
        throw new Error(`Update validation failed: ${optionErrors.join(", ")}`);
      }

      await this.ensureAccessToken();

      await this.retryOperation(async () => {
        return this.youtube.videos.update({
          part: ["snippet", "status"],
          requestBody: {
            id: videoId,
            snippet: {
              ...(updates.title && { title: updates.title.trim() }),
              ...(updates.description && {
                description: updates.description.trim(),
              }),
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
      }, "Video update");

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
      if (!videoId?.trim()) {
        throw new Error("Video ID is required");
      }

      await this.ensureAccessToken();

      await this.retryOperation(async () => {
        return this.youtube.videos.delete({
          id: videoId,
        });
      }, "Video deletion");

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
      if (!videoId?.trim()) {
        throw new Error("Video ID is required");
      }

      await this.ensureAccessToken();

      const response = await this.retryOperation(async () => {
        return this.youtube.videos.list({
          part: ["snippet", "status", "statistics", "contentDetails"],
          id: [videoId],
        });
      }, "Get video details");

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
    isProcessing: boolean;
  }> {
    try {
      if (!videoId?.trim()) {
        throw new Error("Video ID is required");
      }

      await this.ensureAccessToken();

      const response = await this.retryOperation(async () => {
        return this.youtube.videos.list({
          part: ["status", "processingDetails"],
          id: [videoId],
        });
      }, "Check video status");

      const video = response.data.items?.[0];
      if (!video) {
        throw new Error("Video not found");
      }

      const uploadStatus = video.status?.uploadStatus || "unknown";
      const processingStatus =
        video.processingDetails?.processingStatus || "unknown";
      const privacyStatus = video.status?.privacyStatus || "unknown";

      return {
        uploadStatus,
        processingStatus,
        privacyStatus,
        isProcessing:
          processingStatus === "processing" || uploadStatus === "uploaded",
      };
    } catch (error: any) {
      throw new Error(`Failed to check YouTube video status: ${error.message}`);
    }
  }

  /**
   * Wait for video processing to complete
   */
  async waitForVideoProcessing(
    videoId: string,
    maxWaitTime: number = 300000, // 5 minutes default
    checkInterval: number = 10000 // 10 seconds default
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const status = await this.checkVideoStatus(videoId);

        if (!status.isProcessing) {
          console.log(`[YouTube] Video ${videoId} processing completed`);
          return true;
        }

        console.log(
          `[YouTube] Video ${videoId} still processing... (${status.processingStatus})`
        );
        await this.delay(checkInterval);
      } catch (error) {
        console.error(`[YouTube] Error checking video status:`, error);
        await this.delay(checkInterval);
      }
    }

    console.log(
      `[YouTube] Timeout waiting for video ${videoId} processing to complete`
    );
    return false;
  }

  /**
   * Generate OAuth2 authorization URL (for initial setup)
   */
  getAuthUrl(): string {
    const scopes = [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube",
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ];

    return this.oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: scopes,
      prompt: "consent", // Force consent screen to get refresh token
      include_granted_scopes: true,
    });
  }

  /**
   * Exchange authorization code for tokens (for initial setup)
   */
  async getTokensFromCode(code: string): Promise<Credentials> {
    try {
      if (!code?.trim()) {
        throw new Error("Authorization code is required");
      }

      const { tokens } = await this.oauth2Client.getToken(code);
      this.oauth2Client.setCredentials(tokens);

      // Save tokens immediately
      await this.tokenStorage.saveTokens(tokens);

      console.log("[YouTube] Authentication successful, tokens saved");
      return tokens;
    } catch (error: any) {
      console.error("[YouTube] Failed to exchange authorization code:", error);
      throw new Error(
        `Failed to exchange authorization code: ${error.message}. ` +
          `Make sure the code is valid and hasn't expired.`
      );
    }
  }

  /**
   * Check if the service is properly authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    try {
      const tokens = this.oauth2Client.credentials;
      if (!tokens.refresh_token && !tokens.access_token) {
        console.log("[YouTube] No tokens available for authentication check");
        return false;
      }

      await this.ensureAccessToken();

      // Test API access with a simple call
      const response = await this.youtube.channels.list({
        part: ["snippet"],
        mine: true,
        maxResults: 1,
      });

      const isAuth = !!(response.data && response.data.items);
      console.log(
        `[YouTube] Authentication check: ${isAuth ? "SUCCESS" : "FAILED"}`
      );
      return isAuth;
    } catch (error: any) {
      console.error("[YouTube] Authentication check failed:", error.message);
      return false;
    }
  }

  /**
   * Get channel information
   */
  async getChannelInfo() {
    try {
      await this.ensureAccessToken();

      const response = await this.retryOperation(async () => {
        return this.youtube.channels.list({
          part: ["snippet", "statistics", "status"],
          mine: true,
        });
      }, "Get channel info");

      const channelInfo = response.data.items?.[0] || null;
      if (channelInfo) {
        console.log(
          `[YouTube] Channel info retrieved for: ${channelInfo.snippet?.title}`
        );
      }
      return channelInfo;
    } catch (error: any) {
      throw new Error(`Failed to get channel information: ${error.message}`);
    }
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    try {
      this.removeAllListeners();
      console.log("[YouTube] Service cleaned up");
    } catch (error) {
      console.error("[YouTube] Cleanup error:", error);
    }
  }

  /**
   * Get current authentication status and details
   */
  async getAuthStatus(): Promise<{
    isAuthenticated: boolean;
    hasRefreshToken: boolean;
    hasAccessToken: boolean;
    accessTokenExpiry: number | null;
    channelName?: string | undefined;
    channelId?: string | undefined;
  }> {
    try {
      const tokens = this.oauth2Client.credentials;
      const hasRefreshToken = !!(tokens && tokens.refresh_token);
      const hasAccessToken = !!(tokens && tokens.access_token);
      const accessTokenExpiry =
        tokens && tokens.expiry_date ? tokens.expiry_date : null;

      let isAuthenticated = false;
      let channelName: string | undefined = undefined;
      let channelId: string | undefined = undefined;

      if (hasRefreshToken || hasAccessToken) {
        try {
          await this.ensureAccessToken();
          const channelInfo = await this.getChannelInfo();
          isAuthenticated = !!channelInfo;
          channelName = channelInfo?.snippet?.title || undefined;
          channelId = channelInfo?.id || undefined;
        } catch (error) {
          console.log(
            "[YouTube] Authentication test failed during status check"
          );
        }
      }

      const result: {
        isAuthenticated: boolean;
        hasRefreshToken: boolean;
        hasAccessToken: boolean;
        accessTokenExpiry: number | null;
        channelName?: string | undefined;
        channelId?: string | undefined;
      } = {
        isAuthenticated,
        hasRefreshToken,
        hasAccessToken,
        accessTokenExpiry,
      };

      if (channelName !== undefined) {
        result.channelName = channelName;
      }

      if (channelId !== undefined) {
        result.channelId = channelId;
      }

      return result;
    } catch (error: any) {
      console.error("[YouTube] Failed to get auth status:", error);
      return {
        isAuthenticated: false,
        hasRefreshToken: false,
        hasAccessToken: false,
        accessTokenExpiry: null,
      };
    }
  }

  /**
   * Clear stored authentication tokens
   */
  async clearTokens(): Promise<void> {
    try {
      // Clear from OAuth client
      this.oauth2Client.setCredentials({});

      // Clear from storage by saving empty credentials
      await this.tokenStorage.saveTokens({});

      console.log("[YouTube] Authentication tokens cleared");
    } catch (error: any) {
      console.error("[YouTube] Failed to clear tokens:", error);
      throw new Error(`Failed to clear tokens: ${error.message}`);
    }
  }
}
