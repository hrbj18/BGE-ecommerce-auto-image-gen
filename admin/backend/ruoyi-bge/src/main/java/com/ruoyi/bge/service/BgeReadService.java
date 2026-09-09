package com.ruoyi.bge.service;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import com.fasterxml.jackson.databind.JsonNode;
import com.ruoyi.bge.client.BgeEngineClient;
import com.ruoyi.bge.client.BgeEngineClient.AssetResponse;
import com.ruoyi.bge.domain.BgeDtos.Asset;
import com.ruoyi.bge.domain.BgeDtos.Disk;
import com.ruoyi.bge.domain.BgeDtos.Event;
import com.ruoyi.bge.domain.BgeDtos.Health;
import com.ruoyi.bge.domain.BgeDtos.Output;
import com.ruoyi.bge.domain.BgeDtos.OutputFiles;
import com.ruoyi.bge.domain.BgeDtos.Progress;
import com.ruoyi.bge.domain.BgeDtos.TaskDetail;
import com.ruoyi.bge.domain.BgeDtos.TaskList;
import com.ruoyi.bge.domain.BgeDtos.TaskSummary;
import com.ruoyi.bge.domain.BgeDtos.Timing;
import com.ruoyi.bge.support.BgePathPolicy;
import com.ruoyi.bge.support.BgeProxyException;
import com.ruoyi.bge.support.BgeSafeText;
import org.springframework.stereotype.Service;

/**
 * 读取上游数据并转换为最小必要的管理台 DTO。
 */
@Service
public class BgeReadService
{
    private static final int MAX_TASKS = 200;
    private static final int MAX_EVENTS = 40;
    private static final int MAX_ASSETS_PER_GROUP = 20;

    private final BgeEngineClient client;

    public BgeReadService(BgeEngineClient client)
    {
        this.client = client;
    }

    public Health health()
    {
        JsonNode source = client.getJson("/health");
        JsonNode disk = source.path("disk");
        return new Health(
                text(source, "status", 32),
                text(source, "state", 32),
                text(source, "service", 64),
                longNumber(source, "uptimeSeconds", 0, Long.MAX_VALUE),
                integer(source, "activeJobs", 0, 1_000),
                safeIdentifierOrEmpty(source.path("activeJobId").asText("")),
                text(source, "activePhase", 48),
                source.path("acceptingJobs").asBoolean(false),
                new Disk(disk.path("ok").asBoolean(false), nullableDouble(disk, "availableGiB"),
                        nullableDouble(disk, "minimumGiB")));
    }

    public TaskList tasks(String productNameFilter, String statusFilter)
    {
        String productName = BgePathPolicy.filter(productNameFilter);
        String status = BgePathPolicy.filter(statusFilter);
        JsonNode source = client.getJson("/api/tasks");
        JsonNode taskNodes = source.path("tasks");
        if (!taskNodes.isArray())
        {
            throw BgeProxyException.invalidUpstream();
        }
        String normalizedName = productName.toLowerCase(Locale.ROOT);
        List<TaskSummary> tasks = new ArrayList<>();
        for (JsonNode taskNode : taskNodes)
        {
            TaskSummary task = mapTaskSummary(taskNode, false);
            if (task == null)
            {
                continue;
            }
            if (!normalizedName.isEmpty()
                    && !task.productName().toLowerCase(Locale.ROOT).contains(normalizedName))
            {
                continue;
            }
            if (!status.isEmpty() && !task.status().equalsIgnoreCase(status))
            {
                continue;
            }
            tasks.add(task);
            if (tasks.size() == MAX_TASKS)
            {
                break;
            }
        }
        return new TaskList(List.copyOf(tasks), safeIdentifierOrEmpty(source.path("activeJobId").asText("")),
                text(source, "activePhase", 48));
    }

    public TaskDetail task(String rawTaskId)
    {
        String taskId = BgePathPolicy.identifier(rawTaskId);
        JsonNode source = client.getJson("/api/tasks/" + BgePathPolicy.encode(taskId));
        TaskSummary summary = mapTaskSummary(source, true);
        if (summary == null)
        {
            throw BgeProxyException.invalidUpstream();
        }
        List<Event> events = mapEvents(source.path("events"));
        Output output = null;
        if (source.path("output").isObject())
        {
            output = mapOutput(source.path("output"), summary.outputId());
        }
        return new TaskDetail(summary.id(), summary.taskId(), summary.productName(), summary.outputId(),
                summary.status(), summary.message(), summary.progress(), summary.timing(), summary.createdAt(),
                summary.updatedAt(), summary.submittedAtLocal(), summary.referenceCount(), summary.targetPlatform(),
                summary.outputLanguage(), summary.suiteRatio(), summary.generationProfileId(),
                summary.imageAspectRatioProfileId(), summary.imageResolutionId(), summary.imageResolutionLabel(), summary.mainImageCount(),
                summary.detailImageCount(), summary.promptAvailable(), summary.promptComplete(),
                summary.outputProductName(), summary.outputDisplayName(), summary.hasOutput(), summary.eventCount(),
                summary.latestEvent(), events, output);
    }

    public Output output(String rawOutputId)
    {
        String outputId = BgePathPolicy.identifier(rawOutputId);
        JsonNode source = client.getJson("/api/outputs/" + BgePathPolicy.encode(outputId));
        return mapOutput(source, outputId);
    }

    public AssetResponse asset(String rawOutputId, String rawGroup, String rawFilename)
    {
        String outputId = BgePathPolicy.identifier(rawOutputId);
        String group = BgePathPolicy.group(rawGroup);
        String filename = BgePathPolicy.filename(rawFilename, group);
        StringBuilder path = new StringBuilder("/outputs/")
                .append(BgePathPolicy.encode(outputId)).append('/');
        if (!"overview".equals(group))
        {
            path.append(group).append('/');
        }
        path.append(BgePathPolicy.encode(filename));
        return client.openAsset(path.toString());
    }

    private TaskSummary mapTaskSummary(JsonNode source, boolean requireIdentifier)
    {
        if (!source.isObject())
        {
            return null;
        }
        String id = safeIdentifierOrEmpty(source.path("id").asText(""));
        String taskId = safeIdentifierOrEmpty(source.path("taskId").asText(""));
        if (id.isEmpty())
        {
            id = taskId;
        }
        if (taskId.isEmpty())
        {
            taskId = id;
        }
        if (id.isEmpty())
        {
            if (requireIdentifier)
            {
                throw BgeProxyException.invalidUpstream();
            }
            return null;
        }
        String outputId = safeIdentifierOrEmpty(source.path("outputId").asText(""));
        int mainImageCount = imageCount(source, "mainImageCount", 5, 5);
        int detailImageCount = imageCount(source, "detailImageCount", 8, 8);
        return new TaskSummary(
                id,
                taskId,
                text(source, "productName", 160),
                outputId,
                text(source, "status", 48),
                text(source, "message", 320),
                mapProgress(source.path("progress"), mainImageCount, detailImageCount),
                mapTiming(source.path("timing")),
                text(source, "createdAt", 48),
                text(source, "updatedAt", 48),
                text(source, "submittedAtLocal", 48),
                integer(source, "referenceCount", 0, 100),
                text(source, "targetPlatform", 80),
                text(source, "outputLanguage", 48),
                text(source, "suiteRatio", 32),
                text(source, "generationProfileId", 48),
                imageAspectRatioProfileId(source),
                imageResolutionId(source),
                text(source, "imageResolutionLabel", 48),
                mainImageCount,
                detailImageCount,
                source.path("promptAvailable").asBoolean(false),
                source.path("promptComplete").asBoolean(false),
                text(source, "outputProductName", 160),
                text(source, "outputDisplayName", 160),
                source.path("hasOutput").asBoolean(false),
                integer(source, "eventCount", 0, 10_000),
                mapEvent(source.path("latestEvent")));
    }

    private Output mapOutput(JsonNode source, String fallbackOutputId)
    {
        if (!source.isObject())
        {
            throw BgeProxyException.invalidUpstream();
        }
        String id = safeIdentifierOrEmpty(source.path("id").asText(""));
        if (id.isEmpty())
        {
            id = safeIdentifierOrEmpty(fallbackOutputId);
        }
        if (id.isEmpty())
        {
            throw BgeProxyException.invalidUpstream();
        }
        JsonNode files = source.path("files");
        int mainImageCount = imageCount(source, "mainImageCount", 5, 5);
        int detailImageCount = imageCount(source, "detailImageCount", 8, 8);
        OutputFiles safeFiles = new OutputFiles(
                mapAssets(files.path("main"), id, "main"),
                mapAssets(files.path("detail"), id, "detail"),
                overviewUrl(files.path("mainOverview"), id, mainImageCount + "张主图总览.jpg"),
                overviewUrl(files.path("detailOverview"), id, detailImageCount + "张详情页总览.jpg"),
                overviewUrl(files.path("longDetail"), id, "详情页完整长图.jpg"));
        return new Output(
                id,
                id,
                text(source, "productName", 160),
                text(source, "displayName", 160),
                safeIdentifierOrEmpty(source.path("taskId").asText("")),
                text(source, "submittedAt", 48),
                text(source, "submittedAtLocal", 48),
                source.path("materialExists").asBoolean(false),
                text(source, "status", 48),
                text(source, "errorMessage", 320),
                text(source, "updatedAt", 48),
                imageResolutionId(source),
                text(source, "imageResolutionLabel", 48),
                mainImageCount,
                detailImageCount,
                safeFiles);
    }

    private String imageResolutionId(JsonNode source)
    {
        String value = text(source, "imageResolutionId", 16).toLowerCase(java.util.Locale.ROOT);
        return switch (value)
        {
            case "720p", "1k", "2k", "4k" -> value;
            default -> "2k";
        };
    }

    private String imageAspectRatioProfileId(JsonNode source)
    {
        String value = text(source, "imageAspectRatioProfileId", 48).toLowerCase(java.util.Locale.ROOT);
        return switch (value)
        {
            case "ecommerce-standard", "portrait-main" -> value;
            default -> text(source, "suiteRatio", 32).replace(" ", "").contains("3:4")
                    ? "portrait-main"
                    : "ecommerce-standard";
        };
    }

    private List<Asset> mapAssets(JsonNode source, String outputId, String group)
    {
        if (!source.isArray())
        {
            return List.of();
        }
        List<Asset> assets = new ArrayList<>();
        for (JsonNode item : source)
        {
            String name = item.path("name").asText("");
            if (!BgePathPolicy.isSafeFilename(name, group))
            {
                continue;
            }
            assets.add(new Asset(name, proxyAssetUrl(outputId, group, name)));
            if (assets.size() == MAX_ASSETS_PER_GROUP)
            {
                break;
            }
        }
        return List.copyOf(assets);
    }

    private String overviewUrl(JsonNode upstreamValue, String outputId, String filename)
    {
        return upstreamValue.isTextual() && !upstreamValue.asText().isBlank()
                ? proxyAssetUrl(outputId, "overview", filename)
                : "";
    }

    private String proxyAssetUrl(String outputId, String group, String filename)
    {
        return "/bge/outputs/" + BgePathPolicy.encode(outputId) + "/assets/" + group + "/"
                + BgePathPolicy.encode(filename);
    }

    private List<Event> mapEvents(JsonNode source)
    {
        if (!source.isArray())
        {
            return List.of();
        }
        List<Event> events = new ArrayList<>();
        int start = Math.max(0, source.size() - MAX_EVENTS);
        for (int index = start; index < source.size(); index++)
        {
            Event event = mapEvent(source.get(index));
            if (event != null)
            {
                events.add(event);
            }
        }
        return List.copyOf(events);
    }

    private Event mapEvent(JsonNode source)
    {
        if (!source.isObject())
        {
            return null;
        }
        return new Event(text(source, "id", 100), text(source, "type", 64),
                text(source, "message", 240), text(source, "createdAt", 48));
    }

    private Progress mapProgress(JsonNode source, int mainImageCount, int detailImageCount)
    {
        if (!source.isObject())
        {
            return null;
        }
        return new Progress(
                text(source, "stage", 48),
                text(source, "message", 240),
                integer(source, "total", 0, 100),
                integer(source, "completed", 0, 100),
                integer(source, "mainCompleted", 0, mainImageCount),
                integer(source, "detailCompleted", 0, detailImageCount),
                integer(source, "retries", 0, 100),
                integer(source, "backpressureCount", 0, 100),
                integer(source, "concurrency", 0, 8),
                integer(source, "qualityRetryTotal", 0, mainImageCount + detailImageCount),
                integer(source, "qualityRetryCompleted", 0, mainImageCount + detailImageCount),
                nullableLong(source, "nextRetryDelayMs", 0, 300_000),
                text(source, "firstPreviewAt", 48),
                nullableLong(source, "firstPreviewElapsedMs", 0, 7_200_000),
                text(source, "updatedAt", 48));
    }

    private Timing mapTiming(JsonNode source)
    {
        if (!source.isObject())
        {
            return null;
        }
        return new Timing(text(source, "workflowStartedAt", 48), text(source, "firstPreviewAt", 48),
                longNumber(source, "firstPreviewElapsedMs", 0, 7_200_000));
    }

    private String safeIdentifierOrEmpty(String value)
    {
        return BgePathPolicy.isSafeIdentifier(value) ? value.trim() : "";
    }

    private String text(JsonNode source, String field, int maximumLength)
    {
        JsonNode value = source.path(field);
        return value.isValueNode() ? BgeSafeText.value(value.asText(""), maximumLength) : "";
    }

    private int integer(JsonNode source, String field, int minimum, int maximum)
    {
        long value = longNumber(source, field, minimum, maximum);
        return (int) value;
    }

    private int imageCount(JsonNode source, String field, int fallback, int maximum)
    {
        JsonNode value = source.path(field);
        if (!value.canConvertToLong())
        {
            return fallback;
        }
        return (int) Math.max(0, Math.min(maximum, value.asLong(fallback)));
    }

    private long longNumber(JsonNode source, String field, long minimum, long maximum)
    {
        long value = source.path(field).canConvertToLong() ? source.path(field).asLong(minimum) : minimum;
        return Math.max(minimum, Math.min(maximum, value));
    }

    private Long nullableLong(JsonNode source, String field, long minimum, long maximum)
    {
        JsonNode value = source.path(field);
        if (!value.canConvertToLong())
        {
            return null;
        }
        return Math.max(minimum, Math.min(maximum, value.asLong()));
    }

    private Double nullableDouble(JsonNode source, String field)
    {
        JsonNode value = source.path(field);
        if (!value.isNumber() || !Double.isFinite(value.asDouble()))
        {
            return null;
        }
        return Math.max(0.0, Math.min(1_000_000.0, value.asDouble()));
    }
}
