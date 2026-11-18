import type { OpenFeedbackOptions } from "../feedback/model";
import { shareText, type SharePayload } from "./plugin";

/** Feedback is text only (it may become a GitHub issue, which cannot carry the image), so shared images are left out with a note. */
export function shareFeedbackOptions(payload: SharePayload): OpenFeedbackOptions {
  const images = payload.images.length;
  return { text: shareText(payload).slice(0, 2000), ...(images ? { notice: `反馈不带图片，分享的 ${images} 张图没有附上，请用文字写清看到的情况。` } : {}) };
}
