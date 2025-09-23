import sys
import os
import subprocess
from pathlib import Path

def text_to_speech(text, output_path):
    """
    Convert text to speech using Piper TTS, prioritizing a pre-downloaded model.

    Args:
        text (str): Text to convert to speech.
        output_path (str): Path where the audio file should be saved.
    """
    try:
        # --- Piper TTS Configuration (using amy-medium) ---
        model_name = "en_US-amy-medium"
        # Absolute path for the models directory, consistent with the Dockerfile
        models_dir = Path("/home/manim/piper_models")
        model_path = models_dir / f"{model_name}.onnx"
        model_config_path = models_dir / f"{model_name}.onnx.json"

        # --- Check for Model (with fallback download) ---
        if not model_path.is_file() or not model_config_path.is_file():
            print(f"Warning: Pre-downloaded model '{model_name}' not found. Attempting to download...")
            os.makedirs(models_dir, exist_ok=True)
            
            onnx_url = f"https://huggingface.co/rhasspy/piper-voices/resolve/main/{model_name}.onnx"
            json_url = f"https://huggingface.co/rhasspy/piper-voices/resolve/main/{model_name}.onnx.json"

            try:
                subprocess.run(["curl", "--fail", "-L", "-o", str(model_path), onnx_url], check=True)
                subprocess.run(["curl", "--fail", "-L", "-o", str(model_config_path), json_url], check=True)
                print("Model downloaded successfully.")
            except subprocess.CalledProcessError as e:
                print(f"FATAL: Could not download the model. Error: {e}", file=sys.stderr)
                sys.exit(1)

        # --- Audio Generation ---
        output_dir = Path(output_path).parent
        os.makedirs(output_dir, exist_ok=True)

        piper_executable = "piper"
        wav_path = str(Path(output_path).with_suffix('.wav'))
        
        command = [piper_executable, "--model", str(model_path), "--output_file", wav_path]

        print("Running Piper TTS command...")
        subprocess.run(
            command, input=text, text=True, capture_output=True, check=True, encoding='utf-8'
        )

        # --- Convert WAV to MP3 ---
        if output_path.endswith('.mp3'):
            print(f"Converting {wav_path} to {output_path}...")
            ffmpeg_command = [
                'ffmpeg', '-y', '-i', wav_path, '-acodec', 'libmp3lame',
                '-b:a', '128k', output_path
            ]
            subprocess.run(ffmpeg_command, check=True, capture_output=True)
            os.remove(wav_path)
            print(f"Successfully generated audio at {output_path}")
        else:
            print(f"Successfully generated audio at {wav_path}")

    except subprocess.CalledProcessError as e:
        print(f"Error during audio generation: {e}", file=sys.stderr)
        print(f"Stderr: {e.stderr.decode('utf-8', errors='ignore')}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"An unexpected error occurred: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python generate_audio.py <text> <output_path>", file=sys.stderr)
        sys.exit(1)
    
    text_content = sys.argv[1]
    file_path = sys.argv[2]
    
    if not text_content.strip():
        print("Error: Text content cannot be empty", file=sys.stderr)
        sys.exit(1)
        
    text_to_speech(text_content, file_path)