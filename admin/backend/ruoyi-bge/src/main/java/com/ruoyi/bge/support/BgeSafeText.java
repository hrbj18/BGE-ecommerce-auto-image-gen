package com.ruoyi.bge.support;

import java.util.regex.Pattern;

/**
 * 对必须展示的上游文本再做一次脱敏和长度限制。
 */
public final class BgeSafeText
{
    private static final Pattern CONTROL = Pattern.compile("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]");
    private static final Pattern URL = Pattern.compile("(?i)\\bhttps?://\\S+");
    private static final Pattern WINDOWS_PATH = Pattern.compile("(?i)(?:[a-z]:[\\\\/]|\\\\\\\\)[^\\r\\n,;，；]+");
    private static final Pattern UNIX_PATH = Pattern.compile("(?<![\\p{L}\\p{N}])/(?:[^\\s/]+/)+[^\\s,;，；]+");
    private static final Pattern SOURCE_ADDRESS = Pattern.compile(
            "(?<!\\d)(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d{1,5})?(?!\\d)");
    private static final Pattern SECRET = Pattern.compile(
            "(?i)(?:(?:api[-_ ]?key|token|authorization|password|secret|activation[-_ ]?code)\\s*[:=]\\s*|bearer\\s+)[^\\s,;，；]+");

    private BgeSafeText()
    {
    }

    public static String value(String value, int maximumLength)
    {
        if (value == null)
        {
            return "";
        }
        String clean = CONTROL.matcher(value).replaceAll("")
                .replaceAll("\\s+", " ")
                .trim();
        clean = SECRET.matcher(clean).replaceAll("[敏感信息已隐藏]");
        clean = URL.matcher(clean).replaceAll("[链接已隐藏]");
        clean = WINDOWS_PATH.matcher(clean).replaceAll("[路径已隐藏]");
        clean = UNIX_PATH.matcher(clean).replaceAll("[路径已隐藏]");
        clean = SOURCE_ADDRESS.matcher(clean).replaceAll("[来源地址已隐藏]");
        if (clean.length() > maximumLength)
        {
            return clean.substring(0, maximumLength) + "…";
        }
        return clean;
    }
}
