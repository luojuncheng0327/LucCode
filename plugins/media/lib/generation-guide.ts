/**
 * 媒体生成指南正文。
 *
 * 这份指南以前是插件自带的 skill 文件，由 system prompt 提供绝对路径让模型自己读盘。
 * 内置插件随服务端运行时分发，安装目录带版本号，每次服务端自更新就整体换新目录并清掉旧的，
 * 于是冻结在会话快照里的那条路径会在下一次更新后失效。改成常量随工具返回后，
 * 指南内容不再依赖任何磁盘路径，也不会有路径进入模型上下文。
 */

export const MEDIA_GENERATION_GUIDE_VERSION = 1;

export const MEDIA_GENERATION_GUIDE = `# Media Generation

Generation is asynchronous. After submission, the tool returns immediately with a pending media block. Tell the user the image or video is being generated and will appear automatically when finished. Do not wait for the background task and do not call stage_files for generated media.

## Tools

### media_generate-image

- \`prompt\` is required.
- \`count\` controls concurrent image count.
- \`image\` accepts a current-session reference image. Prefer \`{ "kind": "session_file", "fileId": "..." }\`.
- \`referenceImages\` accepts multiple current-session reference images. Prefer session_file references.
- \`ratio\`, \`resolution\`, and \`quality\` are normal generation controls.
- \`provider\`, \`model\`, \`mode\`, and \`options\` are advanced overrides. Omit them for ordinary generation unless the user explicitly asked for a provider/model/mode or media_describe-options shows they are needed.
- Do not put mode values such as \`text2image\` or \`image2image\` in \`model\`.

### media_generate-video

- \`prompt\` is required.
- \`image\` is for image-to-video. Prefer \`{ "kind": "session_file", "fileId": "..." }\`.
- \`duration\`, \`ratio\`, and \`resolution\` are normal generation controls.
- \`provider\`, \`model\`, \`mode\`, and \`options\` are advanced overrides. Omit them for ordinary generation unless the user explicitly asked for them.

### media_describe-options

Use this side-effect-free tool only when the user asks for a specific provider/model/mode, asks for advanced parameters, or a default generation path reports a clear unsupported-capability error.

Its provider and model list contains optional advanced overrides, not a required menu. After reading it, continue to omit \`provider\` and \`model\` for ordinary generation so the host applies its configured default or fallback. Set an override only when the user explicitly requested one, or when the default path clearly reports an unsupported capability and the user authorizes trying another provider.

## Routing

| Intent | Tool |
|---|---|
| Generate an image from text | media_generate-image |
| Edit or restyle a reference image | media_generate-image with \`image\` |
| Blend several reference images | media_generate-image with \`referenceImages\` |
| Generate a video from text | media_generate-video |
| Animate an image | media_generate-video with \`image\` |
| Inspect provider/model/mode options | media_describe-options |

## Rules

- Use only the \`media_*\` tools for image and video generation.
- Do not silently switch providers after a failure. Report the error unless the user asks you to try another provider.
- Never interpret media_describe-options candidates as a requirement to choose a provider or model.
- Provider capability comes from Luc Media Provider Registry, not from chat model names.
- If the user wants text inside the image, put the exact text in double quotes inside the prompt.
`;
