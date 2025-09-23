FROM manimcommunity/manim:stable

ENV NODE_ENV=production

# Switch to root to install system-level dependencies
USER root

# Install dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ffmpeg \
        ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install python packages
RUN python3 -m pip install --upgrade pip \
    && python3 -m pip install --no-cache-dir piper-tts

# --- PRE-DOWNLOAD AND VERIFY PIPER VOICE MODEL (amy-medium) ---

# Define the target directory
ARG MODELS_DIR=/home/manim/piper_models

# Step 1: Create the directory for the models
RUN mkdir -p ${MODELS_DIR}

# Step 2: Download the ONNX model file from the path you discovered.
RUN curl --fail --location --output ${MODELS_DIR}/en_US-amy-medium.onnx \
     "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx"

# Step 3: Download the JSON config file from the same location.
RUN curl --fail --location --output ${MODELS_DIR}/en_US-amy-medium.onnx.json \
     "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json"

# Step 4: VERIFY the downloads. This will fail the build if files are missing or empty.
RUN ls -lh ${MODELS_DIR} \
    && find ${MODELS_DIR} -type f -size -1k -exec echo "Error: Found suspiciously small file" {} + -exec exit 1 \; \
    && echo "Model files downloaded and verified successfully."

# --- USER AND PERMISSIONS SETUP ---

# Create the non-root user
RUN useradd -ms /bin/bash manim

# Change ownership of the models and home directory to the new user
RUN chown -R manim:manim ${MODELS_DIR} \
    && chown -R manim:manim /home/manim

# Switch to the non-root user
USER manim
WORKDIR /home/manim/app

# --- APPLICATION SETUP ---

# Copy and install Node.js dependencies
COPY --chown=manim:manim package*.json ./
RUN npm install --only=production

# Copy and generate Prisma client
COPY --chown=manim:manim prisma ./prisma
RUN npx prisma generate

# Copy the rest of the application code
COPY --chown=manim:manim dist ./dist
COPY --chown=manim:manim scripts ./scripts

# Healthcheck to monitor the running container
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ps aux | grep "node dist/workers/videoGeneration.worker.js" || exit 1

# Command to run the worker
CMD ["node", "dist/workers/videoGeneration.worker.js"]