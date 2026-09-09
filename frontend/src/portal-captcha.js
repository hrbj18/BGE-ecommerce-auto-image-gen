export function captchaImageSource(value) {
  const image = String(value ?? "").trim();
  if (!image) return "";
  return image.startsWith("data:image/") ? image : `data:image/jpeg;base64,${image}`;
}
