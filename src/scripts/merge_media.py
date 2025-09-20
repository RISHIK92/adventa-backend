import sys
from moviepy.editor import VideoFileClip, AudioFileClip

# Takes three command-line arguments:
# sys.argv[1]: Input video file path.
# sys.argv[2]: Input audio file path.
# sys.argv[3]: Final merged output video file path.

def merge_audio_video(video_path, audio_path, output_path):
    try:
        video_clip = VideoFileClip(video_path)
        audio_clip = AudioFileClip(audio_path)
        
        # Set the audio of the video clip to the new audio
        final_clip = video_clip.set_audio(audio_clip)
        
        # Write the result to a file
        final_clip.write_videofile(output_path, codec="libx264", audio_codec="aac")
        
        print(f"Successfully merged media to {output_path}")
    except Exception as e:
        print(f"Error merging media: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        if 'video_clip' in locals():
            video_clip.close()
        if 'audio_clip' in locals():
            audio_clip.close()

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python merge_media.py <video_path> <audio_path> <output_path>", file=sys.stderr)
        sys.exit(1)

    video_in = sys.argv[1]
    audio_in = sys.argv[2]
    video_out = sys.argv[3]
    merge_audio_video(video_in, audio_in, video_out)