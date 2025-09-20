import sys
import pyttsx3

# Takes two command-line arguments:
# sys.argv[1]: The text to convert to speech.
# sys.argv[2]: The output file path (e.g., /home/manim/app/temp/audio.mp3).

def text_to_speech(text, output_path):
    try:
        engine = pyttsx3.init()
        engine.save_to_file(text, output_path)
        engine.runAndWait()
        print(f"Successfully generated audio at {output_path}")
    except Exception as e:
        print(f"Error generating audio: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python generate_audio.py <text> <output_path>", file=sys.stderr)
        sys.exit(1)
    
    text_content = sys.argv[1]
    file_path = sys.argv[2]
    text_to_speech(text_content, file_path)