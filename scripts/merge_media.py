import sys
import subprocess
import os
from pathlib import Path

def get_media_duration(file_path):
    """
    Get duration of media file using ffprobe.
    
    Args:
        file_path (str): Path to media file
        
    Returns:
        float: Duration in seconds, or None if unable to determine
    """
    try:
        result = subprocess.run([
            'ffprobe', '-v', 'quiet', '-show_entries', 
            'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', 
            file_path
        ], capture_output=True, text=True, check=True)
        
        return float(result.stdout.strip())
    except (subprocess.CalledProcessError, ValueError):
        return None

def merge_audio_video(video_path, audio_path, output_path):
    """
    Merge video and audio files using FFmpeg.
    
    Args:
        video_path (str): Path to input video file
        audio_path (str): Path to input audio file
        output_path (str): Path for output merged file
    """
    try:
        # Validate input files exist
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"Video file not found: {video_path}")
        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"Audio file not found: {audio_path}")
        
        # Ensure output directory exists
        output_dir = os.path.dirname(output_path)
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
        
        # Get durations to determine which is shorter
        video_duration = get_media_duration(video_path)
        audio_duration = get_media_duration(audio_path)
        
        # Build FFmpeg command
        cmd = [
            'ffmpeg', '-y',  # Overwrite output file
            '-i', video_path,  # Input video
            '-i', audio_path,  # Input audio
        ]
        
        # Handle duration mismatch
        if video_duration and audio_duration:
            if audio_duration > video_duration:
                # Audio is longer - trim audio to match video
                cmd.extend(['-t', str(video_duration)])
                print(f"Audio ({audio_duration:.2f}s) longer than video ({video_duration:.2f}s) - trimming audio")
            elif video_duration > audio_duration:
                # Video is longer - loop audio or pad with silence
                cmd.extend(['-stream_loop', '-1'])  # Loop audio
                cmd.extend(['-shortest'])  # Stop when shortest stream ends
                print(f"Video ({video_duration:.2f}s) longer than audio ({audio_duration:.2f}s) - looping audio")
        else:
            # Fallback to shortest if we can't determine durations
            cmd.extend(['-shortest'])
        
        # Video and audio codec settings
        cmd.extend([
            '-c:v', 'copy',  # Copy video stream (no re-encoding)
            '-c:a', 'aac',   # Encode audio to AAC
            '-b:a', '128k',  # Audio bitrate
            '-strict', 'experimental',  # Allow experimental AAC encoder if needed
            output_path
        ])
        
        print(f"Running FFmpeg command: {' '.join(cmd)}")
        
        # Run FFmpeg
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        
        # Verify output file was created
        if not os.path.exists(output_path):
            raise RuntimeError("Output file was not created")
        
        # Check if output file has reasonable size
        output_size = os.path.getsize(output_path)
        if output_size < 1000:  # Less than 1KB is probably an error
            raise RuntimeError(f"Output file is suspiciously small: {output_size} bytes")
        
        print(f"Successfully merged media to {output_path}")
        print(f"Output file size: {output_size:,} bytes")
        
    except subprocess.CalledProcessError as e:
        error_msg = f"FFmpeg error: {e.stderr}" if e.stderr else str(e)
        print(f"Error during merge: {error_msg}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python merge_media.py <video_path> <audio_path> <output_path>", file=sys.stderr)
        sys.exit(1)
    
    video_file = sys.argv[1]
    audio_file = sys.argv[2]
    output_file = sys.argv[3]
    
    merge_audio_video(video_file, audio_file, output_file)