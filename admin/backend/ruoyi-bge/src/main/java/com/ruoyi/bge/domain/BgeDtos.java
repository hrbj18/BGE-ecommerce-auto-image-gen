package com.ruoyi.bge.domain;

import java.util.List;

/**
 * 若依前端可见的 BGE 只读数据合同。
 *
 * <p>这些类型故意不包含上游的绝对路径、完整日志、完整提示词、
 * 请求来源和任何认证字段。</p>
 */
public final class BgeDtos
{
    private BgeDtos()
    {
    }

    public record Health(String status, String state, String service, long uptimeSeconds,
            int activeJobs, String activeJobId, String activePhase, boolean acceptingJobs, Disk disk)
    {
    }

    public record Disk(boolean ok, Double availableGiB, Double minimumGiB)
    {
    }

    public record TaskList(List<TaskSummary> tasks, String activeJobId, String activePhase)
    {
    }

    public record TaskSummary(String id, String taskId, String productName, String outputId,
            String status, String message, Progress progress, Timing timing, String createdAt,
            String updatedAt, String submittedAtLocal, int referenceCount, String targetPlatform,
            String outputLanguage, String suiteRatio, String generationProfileId,
            String imageAspectRatioProfileId, String imageResolutionId, String imageResolutionLabel, int mainImageCount,
            int detailImageCount, boolean promptAvailable, boolean promptComplete,
            String outputProductName, String outputDisplayName, boolean hasOutput, int eventCount,
            Event latestEvent)
    {
    }

    public record TaskDetail(String id, String taskId, String productName, String outputId,
            String status, String message, Progress progress, Timing timing, String createdAt,
            String updatedAt, String submittedAtLocal, int referenceCount, String targetPlatform,
            String outputLanguage, String suiteRatio, String generationProfileId,
            String imageAspectRatioProfileId, String imageResolutionId, String imageResolutionLabel, int mainImageCount,
            int detailImageCount, boolean promptAvailable, boolean promptComplete,
            String outputProductName, String outputDisplayName, boolean hasOutput, int eventCount,
            Event latestEvent, List<Event> events, Output output)
    {
    }

    public record Progress(String stage, String message, int total, int completed, int mainCompleted,
            int detailCompleted, int retries, int backpressureCount, int concurrency,
            int qualityRetryTotal, int qualityRetryCompleted, Long nextRetryDelayMs,
            String firstPreviewAt, Long firstPreviewElapsedMs, String updatedAt)
    {
    }

    public record Timing(String workflowStartedAt, String firstPreviewAt, long firstPreviewElapsedMs)
    {
    }

    public record Event(String id, String type, String message, String createdAt)
    {
    }

    public record Output(String id, String folderName, String productName, String displayName,
            String taskId, String submittedAt, String submittedAtLocal, boolean materialExists,
            String status, String errorMessage, String updatedAt, String imageResolutionId,
            String imageResolutionLabel, int mainImageCount,
            int detailImageCount, OutputFiles files)
    {
    }

    public record OutputFiles(List<Asset> main, List<Asset> detail, String mainOverview,
            String detailOverview, String longDetail)
    {
    }

    public record Asset(String name, String url)
    {
    }
}
