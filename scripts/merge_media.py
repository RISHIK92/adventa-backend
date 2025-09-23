import sys
import subprocess
import os
import json
from pathlib import Path
from enum import Enum
import tempfile

class SyncMethod(Enum):
    """Different synchronization strategies"""
    VIDEO_SPEED = "video_speed"      # Adjust video speed to match audio
    AUDIO_SPEED = "audio_speed"      # Adjust audio speed to match video  
    BALANCED = "balanced"            # Adjust both slightly toward middle
    CROP_EXTEND = "crop_extend"      # Crop longer or extend shorter
    SMART_AUTO = "smart_auto"        # Automatically choose best method

class MediaSyncer:
    def __init__(self):
        self.temp_dir = None
        
    def __enter__(self):
        self.temp_dir = tempfile.mkdtemp(prefix="media_sync_")
        return self
        
    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.temp_dir and os.path.exists(self.temp_dir):
            import shutil
            shutil.rmtree(self.temp_dir)

    def get_media_info(self, file_path):
        """Get comprehensive media information using ffprobe"""
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")
            
        try:
            result = subprocess.run([
                'ffprobe', '-v', 'quiet', '-print_format', 'json',
                '-show_format', '-show_streams', file_path
            ], capture_output=True, text=True, check=True)
            
            data = json.loads(result.stdout)
            
            info = {
                'duration': float(data['format'].get('duration', 0)),
                'size': int(data['format'].get('size', 0)),
                'bitrate': int(data['format'].get('bit_rate', 0)),
                'streams': []
            }
            
            for stream in data['streams']:
                stream_info = {
                    'type': stream['codec_type'],
                    'codec': stream['codec_name'],
                    'duration': float(stream.get('duration', info['duration']))
                }
                
                if stream['codec_type'] == 'video':
                    stream_info.update({
                        'width': stream.get('width', 0),
                        'height': stream.get('height', 0),
                        'fps': self._parse_framerate(stream.get('r_frame_rate', '0/1'))
                    })
                elif stream['codec_type'] == 'audio':
                    stream_info.update({
                        'sample_rate': int(stream.get('sample_rate', 0)),
                        'channels': stream.get('channels', 0)
                    })
                    
                info['streams'].append(stream_info)
                
            return info
            
        except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError) as e:
            raise RuntimeError(f"Failed to analyze {file_path}: {e}")

    def _parse_framerate(self, fps_str):
        """Parse framerate string like '30/1' to float"""
        try:
            if '/' in fps_str:
                num, den = fps_str.split('/')
                return float(num) / float(den) if float(den) != 0 else 0
            return float(fps_str)
        except:
            return 0

    def analyze_sync_strategy(self, video_info, audio_info):
        """Intelligently determine the best sync strategy"""
        v_dur = video_info['duration']
        a_dur = audio_info['duration']
        
        if v_dur == 0 or a_dur == 0:
            raise ValueError("Invalid media durations")
            
        duration_diff = abs(v_dur - a_dur)
        duration_ratio = max(v_dur, a_dur) / min(v_dur, a_dur)
        
        # Analysis metrics
        analysis = {
            'video_duration': v_dur,
            'audio_duration': a_dur,
            'difference_seconds': duration_diff,
            'difference_percent': (duration_diff / max(v_dur, a_dur)) * 100,
            'duration_ratio': duration_ratio,
            'recommended_method': None,
            'speed_factor_needed': None,
            'quality_impact': 'low'
        }
        
        # Determine quality impact and best method
        if duration_ratio <= 1.05:  # Less than 5% difference
            analysis['recommended_method'] = SyncMethod.CROP_EXTEND
            analysis['quality_impact'] = 'minimal'
        elif duration_ratio <= 1.15:  # 5-15% difference
            analysis['recommended_method'] = SyncMethod.BALANCED
            analysis['quality_impact'] = 'low'
        elif duration_ratio <= 1.5:   # 15-50% difference
            if v_dur > a_dur:
                analysis['recommended_method'] = SyncMethod.VIDEO_SPEED
            else:
                analysis['recommended_method'] = SyncMethod.AUDIO_SPEED
            analysis['quality_impact'] = 'moderate'
        else:  # Major difference
            analysis['recommended_method'] = SyncMethod.BALANCED
            analysis['quality_impact'] = 'high'
            
        analysis['speed_factor_needed'] = v_dur / a_dur
        
        return analysis

    def sync_media(self, video_path, audio_path, output_path, method=SyncMethod.SMART_AUTO, quality='high'):
        """Main synchronization function with multiple strategies"""
        
        print("🎬 Smart Media Synchronization Starting...")
        print("=" * 50)
        
        # Get media information
        video_info = self.get_media_info(video_path)
        audio_info = self.get_media_info(audio_path)
        
        print(f"📹 Video: {video_info['duration']:.2f}s ({video_info['size'] / 1024 / 1024:.1f}MB)")
        print(f"🎵 Audio: {audio_info['duration']:.2f}s ({audio_info['size'] / 1024 / 1024:.1f}MB)")
        
        # Analyze and choose strategy
        analysis = self.analyze_sync_strategy(video_info, audio_info)
        
        if method == SyncMethod.SMART_AUTO:
            method = analysis['recommended_method']
            
        print(f"\n📊 Analysis:")
        print(f"   Duration difference: {analysis['difference_seconds']:.2f}s ({analysis['difference_percent']:.1f}%)")
        print(f"   Quality impact: {analysis['quality_impact']}")
        print(f"   Chosen method: {method.value}")
        
        # Execute the chosen sync method
        success = False
        
        if method == SyncMethod.VIDEO_SPEED:
            success = self._sync_video_speed(video_path, audio_path, output_path, analysis, quality)
        elif method == SyncMethod.AUDIO_SPEED:
            success = self._sync_audio_speed(video_path, audio_path, output_path, analysis, quality)
        elif method == SyncMethod.BALANCED:
            success = self._sync_balanced(video_path, audio_path, output_path, analysis, quality)
        elif method == SyncMethod.CROP_EXTEND:
            success = self._sync_crop_extend(video_path, audio_path, output_path, analysis, quality)
            
        if success:
            final_info = self.get_media_info(output_path)
            print(f"\n✅ Synchronization Successful!")
            print(f"📁 Output: {output_path}")
            print(f"⏱️  Final duration: {final_info['duration']:.2f}s")
            print(f"📦 File size: {final_info['size'] / 1024 / 1024:.1f}MB")
            
        return success

    def _sync_video_speed(self, video_path, audio_path, output_path, analysis, quality):
        """Adjust video speed to match audio duration"""
        speed_factor = analysis['speed_factor_needed']
        
        print(f"\n🎯 Adjusting video speed by factor: {1/speed_factor:.4f}")
        
        # Quality settings
        quality_settings = self._get_quality_settings(quality)
        
        cmd = [
            'ffmpeg', '-y',
            '-i', video_path,
            '-i', audio_path,
            '-filter_complex',
            f'[0:v]setpts={speed_factor:.6f}*PTS[v]',
            '-map', '[v]',
            '-map', '1:a',
            '-c:v', quality_settings['video_codec'],
            '-preset', quality_settings['preset'],
            '-crf', str(quality_settings['crf']),
            '-c:a', quality_settings['audio_codec'],
            '-b:a', quality_settings['audio_bitrate'],
            '-shortest',
            output_path
        ]
        
        return self._execute_ffmpeg(cmd)

    def _sync_audio_speed(self, video_path, audio_path, output_path, analysis, quality):
        """Adjust audio speed to match video duration"""
        speed_factor = 1 / analysis['speed_factor_needed']
        
        print(f"\n🎯 Adjusting audio speed by factor: {speed_factor:.4f}")
        
        # Ensure speed factor is within atempo limits (0.5 to 100.0)
        if speed_factor < 0.5 or speed_factor > 100.0:
            # Use multiple atempo filters for extreme changes
            atempo_chain = self._build_atempo_chain(speed_factor)
        else:
            atempo_chain = f'atempo={speed_factor:.6f}'
        
        quality_settings = self._get_quality_settings(quality)
        
        cmd = [
            'ffmpeg', '-y',
            '-i', video_path,
            '-i', audio_path,
            '-filter_complex',
            f'[1:a]{atempo_chain}[a]',
            '-map', '0:v',
            '-map', '[a]',
            '-c:v', quality_settings['video_codec'],
            '-preset', quality_settings['preset'],
            '-crf', str(quality_settings['crf']),
            '-c:a', quality_settings['audio_codec'],
            '-b:a', quality_settings['audio_bitrate'],
            '-shortest',
            output_path
        ]
        
        return self._execute_ffmpeg(cmd)

    def _sync_balanced(self, video_path, audio_path, output_path, analysis, quality):
        """Adjust both video and audio speeds toward a middle ground"""
        target_duration = (analysis['video_duration'] + analysis['audio_duration']) / 2
        
        video_speed = analysis['video_duration'] / target_duration
        audio_speed = target_duration / analysis['audio_duration']
        
        print(f"\n🎯 Balanced approach:")
        print(f"   Video speed factor: {1/video_speed:.4f}")
        print(f"   Audio speed factor: {audio_speed:.4f}")
        print(f"   Target duration: {target_duration:.2f}s")
        
        atempo_chain = self._build_atempo_chain(audio_speed)
        quality_settings = self._get_quality_settings(quality)
        
        cmd = [
            'ffmpeg', '-y',
            '-i', video_path,
            '-i', audio_path,
            '-filter_complex',
            f'[0:v]setpts={video_speed:.6f}*PTS[v];[1:a]{atempo_chain}[a]',
            '-map', '[v]',
            '-map', '[a]',
            '-c:v', quality_settings['video_codec'],
            '-preset', quality_settings['preset'],
            '-crf', str(quality_settings['crf']),
            '-c:a', quality_settings['audio_codec'],
            '-b:a', quality_settings['audio_bitrate'],
            '-shortest',
            output_path
        ]
        
        return self._execute_ffmpeg(cmd)

    def _sync_crop_extend(self, video_path, audio_path, output_path, analysis, quality):
        """Crop the longer media or extend the shorter one"""
        v_dur = analysis['video_duration']
        a_dur = analysis['audio_duration']
        target_duration = min(v_dur, a_dur)  # Use shorter duration
        
        print(f"\n🎯 Crop/Extend approach - target duration: {target_duration:.2f}s")
        
        quality_settings = self._get_quality_settings(quality)
        
        cmd = [
            'ffmpeg', '-y',
            '-i', video_path,
            '-i', audio_path,
            '-map', '0:v',
            '-map', '1:a',
            '-c:v', quality_settings['video_codec'],
            '-preset', quality_settings['preset'],
            '-crf', str(quality_settings['crf']),
            '-c:a', quality_settings['audio_codec'],
            '-b:a', quality_settings['audio_bitrate'],
            '-t', str(target_duration),  # Limit to target duration
            output_path
        ]
        
        return self._execute_ffmpeg(cmd)

    def _build_atempo_chain(self, speed_factor):
        """Build atempo filter chain for extreme speed changes"""
        if 0.5 <= speed_factor <= 100.0:
            return f'atempo={speed_factor:.6f}'
        
        # For extreme changes, chain multiple atempo filters
        chain = []
        remaining = speed_factor
        
        while remaining > 100.0:
            chain.append('atempo=100.0')
            remaining /= 100.0
        while remaining < 0.5:
            chain.append('atempo=0.5')
            remaining /= 0.5
            
        if remaining != 1.0:
            chain.append(f'atempo={remaining:.6f}')
            
        return ','.join(chain)

    def _get_quality_settings(self, quality):
        """Get quality settings based on preset"""
        settings = {
            'fast': {
                'video_codec': 'libx264',
                'preset': 'veryfast',
                'crf': 28,
                'audio_codec': 'aac',
                'audio_bitrate': '128k'
            },
            'balanced': {
                'video_codec': 'libx264',
                'preset': 'medium',
                'crf': 23,
                'audio_codec': 'aac',
                'audio_bitrate': '192k'
            },
            'high': {
                'video_codec': 'libx264',
                'preset': 'slow',
                'crf': 18,
                'audio_codec': 'aac',
                'audio_bitrate': '320k'
            }
        }
        return settings.get(quality, settings['balanced'])

    def _execute_ffmpeg(self, cmd):
        """Execute FFmpeg command with progress tracking"""
        print(f"\n🔄 Executing: {' '.join(cmd[:8])}...")
        
        try:
            process = subprocess.Popen(
                cmd, 
                stdout=subprocess.PIPE, 
                stderr=subprocess.PIPE, 
                universal_newlines=True
            )
            
            stdout, stderr = process.communicate()
            
            if process.returncode != 0:
                print(f"❌ FFmpeg failed with return code {process.returncode}")
                print(f"Error output: {stderr}")
                return False
                
            return True
            
        except Exception as e:
            print(f"❌ Execution failed: {e}")
            return False


def main():
    if len(sys.argv) < 4:
        print("""
🎬 Smart Media Synchronization Tool

Usage: python smart_sync.py <video> <audio> <output> [method] [quality]

Methods:
  - video_speed: Adjust video speed (default for most cases)
  - audio_speed: Adjust audio speed  
  - balanced: Adjust both toward middle
  - crop_extend: Crop longer or extend shorter
  - smart_auto: Automatically choose best method (recommended)

Quality: fast, balanced, high

Example: python smart_sync.py video.mp4 audio.wav output.mp4 smart_auto high
        """)
        sys.exit(1)
    
    video_file = sys.argv[1]
    audio_file = sys.argv[2]
    output_file = sys.argv[3]
    method = SyncMethod(sys.argv[4]) if len(sys.argv) > 4 else SyncMethod.SMART_AUTO
    quality = sys.argv[5] if len(sys.argv) > 5 else 'balanced'
    
    # Ensure output directory exists
    os.makedirs(Path(output_file).parent, exist_ok=True)
    
    with MediaSyncer() as syncer:
        success = syncer.sync_media(video_file, audio_file, output_file, method, quality)
        sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()