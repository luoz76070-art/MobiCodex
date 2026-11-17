import { feedbackScreenshot, type OpenFeedbackOptions } from "../feedback/model";
import { shareFiles, shareText, type SharePayload } from "./plugin";

/** Prepare only the first image; the feedback sheet still requires an explicit submit. */
export async function shareFeedbackOptions(payload: SharePayload, signal: AbortSignal): Promise<OpenFeedbackOptions> {
  const image = payload.images[0];
  let screenshot: File | undefined, notice: string | undefined;
  if (image) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(image.mimeType)) notice = "分享图片未附上：仅支持 PNG、JPEG、WebP。";
    else if (image.size > 5 * 1024 * 1024) notice = "分享图片未附上：截图最多 5MiB。";
    else {
      try {
        [screenshot] = await shareFiles({ ...payload, images: [image] }, (input, init) => fetch(input, { ...init, signal }));
        await feedbackScreenshot(screenshot);
      } catch {
        screenshot = undefined; notice = "分享图片未附上：无法读取，或不是 5MiB 以内的有效 PNG、JPEG、WebP。";
      }
    }
  }
  const omitted = payload.images.length - (screenshot ? 1 : 0);
  const suffix = payload.images.length > 1 ? `\n\n另有 ${omitted} 张图未附上` : "";
  return { text: shareText(payload).slice(0, 2000 - suffix.length) + suffix, screenshot, notice };
}
