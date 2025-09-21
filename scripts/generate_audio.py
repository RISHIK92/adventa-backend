import sys
import pyttsx3
import os
from pathlib import Path

def text_to_speech(text, output_path):
    """
    Convert text to speech and save as audio file.
    
    Args:
        text (str): Text to convert to speech
        output_path (str): Path where audio file should be saved
    """
    try:
        # Ensure output directory exists
        output_dir = os.path.dirname(output_path)
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
        
        # Initialize TTS engine
        engine = pyttsx3.init()
        
        # Configure engine properties for better quality
        engine.setProperty('rate', 150)  # Speed of speech (words per minute)
        engine.setProperty('volume', 0.9)  # Volume level (0.0 to 1.0)
        
        # Get available voices and set a clear one if possible
        voices = engine.getProperty('voices')
        if voices:
            # Try to find an English voice
            for voice in voices:
                if 'english' in voice.name.lower() or 'en_' in voice.id.lower():
                    engine.setProperty('voice', voice.id)
                    break
        
        # Convert output path to WAV first (pyttsx3 works better with WAV)
        wav_path = output_path.replace('.mp3', '.wav')
        
        # Save to file
        engine.save_to_file(text, wav_path)
        engine.runAndWait()
        
        # Convert WAV to MP3 using ffmpeg if needed
        if output_path.endswith('.mp3') and wav_path != output_path:
            import subprocess
            try:
                subprocess.run([
                    'ffmpeg', '-y', '-i', wav_path, 
                    '-acodec', 'libmp3lame', '-b:a', '128k',
                    output_path
                ], check=True, capture_output=True)
                
                # Remove the temporary WAV file
                os.remove(wav_path)
                print(f"Successfully generated audio at {output_path}")
            except subprocess.CalledProcessError as e:
                print(f"Error converting to MP3: {e}", file=sys.stderr)
                # Keep the WAV file if MP3 conversion fails
                print(f"Audio saved as WAV at {wav_path}")
        else:
            print(f"Successfully generated audio at {wav_path}")
            
    except Exception as e:
        print(f"Error generating audio: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python generate_audio.py <text> <output_path>", file=sys.stderr)
        sys.exit(1)
    
    text_content = sys.argv[1]
    file_path = sys.argv[2]
    
    # Validate inputs
    if not text_content.strip():
        print("Error: Text content cannot be empty", file=sys.stderr)
        sys.exit(1)
    
    text_to_speech(text_content, file_path)