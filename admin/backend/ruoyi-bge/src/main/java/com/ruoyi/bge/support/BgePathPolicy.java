package com.ruoyi.bge.support;

import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.web.util.UriUtils;

/**
 * BGE 代理中所有路径段的唯一校验入口。
 */
public final class BgePathPolicy
{
    private static final int MAX_IDENTIFIER_LENGTH = 120;
    private static final int MAX_FILENAME_LENGTH = 140;
    private static final Pattern FORBIDDEN = Pattern.compile("[\\x00-\\x1f\\x7f/\\\\:<>\"|?*%]");
    private static final Set<String> GROUPS = Set.of("main", "detail", "overview");
    private static final Set<String> IMAGE_EXTENSIONS = Set.of(".jpg", ".jpeg", ".png", ".webp", ".gif");
    /**
     * Overview files are generated only by the released suite profiles. Keep this
     * as an exact allowlist: accepting every file in the output root would turn
     * this endpoint into a broader file-serving surface.
     */
    private static final Set<String> OVERVIEW_FILES = Set.of(
            "1张主图总览.jpg", "2张主图总览.jpg", "3张主图总览.jpg", "5张主图总览.jpg",
            "2张详情页总览.jpg", "3张详情页总览.jpg", "4张详情页总览.jpg", "8张详情页总览.jpg",
            "详情页完整长图.jpg");

    private BgePathPolicy()
    {
    }

    public static String identifier(String value)
    {
        return segment(value, MAX_IDENTIFIER_LENGTH, false);
    }

    public static String filename(String value, String group)
    {
        String safeGroup = group(group);
        String safe = segment(value, MAX_FILENAME_LENGTH, true);
        if ("overview".equals(safeGroup))
        {
            if (!OVERVIEW_FILES.contains(safe))
            {
                throw BgeProxyException.invalidParameter();
            }
            return safe;
        }
        String lower = safe.toLowerCase(Locale.ROOT);
        boolean allowed = IMAGE_EXTENSIONS.stream().anyMatch(lower::endsWith);
        if (!allowed)
        {
            throw BgeProxyException.invalidParameter();
        }
        return safe;
    }

    public static String group(String value)
    {
        if (value == null || !GROUPS.contains(value))
        {
            throw BgeProxyException.invalidParameter();
        }
        return value;
    }

    public static String filter(String value)
    {
        if (value == null)
        {
            return "";
        }
        String clean = value.trim();
        if (clean.length() > 80 || FORBIDDEN.matcher(clean).find())
        {
            throw BgeProxyException.invalidParameter();
        }
        return clean;
    }

    public static boolean isSafeIdentifier(String value)
    {
        try
        {
            identifier(value);
            return true;
        }
        catch (BgeProxyException ignored)
        {
            return false;
        }
    }

    public static boolean isSafeFilename(String value, String group)
    {
        try
        {
            filename(value, group);
            return true;
        }
        catch (BgeProxyException ignored)
        {
            return false;
        }
    }

    public static String encode(String value)
    {
        return UriUtils.encodePathSegment(value, StandardCharsets.UTF_8);
    }

    private static String segment(String value, int maximumLength, boolean allowSpaces)
    {
        if (value == null)
        {
            throw BgeProxyException.invalidParameter();
        }
        String clean = value.trim();
        if (clean.isEmpty() || clean.length() > maximumLength || ".".equals(clean) || "..".equals(clean)
                || FORBIDDEN.matcher(clean).find() || (!allowSpaces && containsUnsafeWhitespace(clean)))
        {
            throw BgeProxyException.invalidParameter();
        }
        return clean;
    }

    private static boolean containsUnsafeWhitespace(String value)
    {
        return value.codePoints().anyMatch(character -> Character.isWhitespace(character) && character != ' ');
    }
}
