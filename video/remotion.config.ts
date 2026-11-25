import { Config } from '@remotion/cli/config';

Config.setEntryPoint('src/index.ts');
Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(95);
Config.setOverwriteOutput(true);
// The liquid is a WebGL shader, so the renderer needs a real GL backend.
Config.setChromiumOpenGlRenderer('angle');
