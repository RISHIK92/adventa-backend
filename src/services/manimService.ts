import { execFile } from "child_process";
import { writeFile } from "fs/promises";
import path from "path";

class ManimRenderError extends Error {
  /* ... */
}

export const Manim = {
  async render(manimCode: string, workDir: string): Promise<string> {
    const sceneName = "GeneratedScene"; // This should be parsed from the code or standardized
    const scriptPath = path.join(workDir, "scene.py");
    await writeFile(scriptPath, manimCode);

    const videoPath = path.join(
      workDir,
      "media",
      "videos",
      "scene",
      "1080p60",
      `${sceneName}.mp4`
    );

    return new Promise((resolve, reject) => {
      const command = "manim";
      // The `render` subcommand is essential
      const args = [
        "render",
        scriptPath,
        sceneName,
        "--quality",
        "h",
        "--media_dir",
        workDir,
      ];

      execFile(command, args, (error, stdout, stderr: any) => {
        if (error) {
          return reject(
            new ManimRenderError("Manim rendering failed.", stderr)
          );
        }
        resolve(videoPath);
      });
    });
  },
};
