package com.ruoyi.bge.controller;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.ruoyi.bge.client.BgeEngineClient;
import com.ruoyi.bge.client.BgeEngineClient.AssetResponse;
import com.ruoyi.bge.client.BgeEngineClient.JsonResponse;
import com.ruoyi.bge.client.BgeEngineClient.WorkbenchResponse;
import com.ruoyi.bge.domain.BgeDtos.Asset;
import com.ruoyi.bge.domain.BgeDtos.Output;
import com.ruoyi.bge.domain.BgeDtos.TaskDetail;
import com.ruoyi.bge.portal.BgePortalOwnershipRepository;
import com.ruoyi.bge.portal.PortalUserService;
import com.ruoyi.bge.portal.PortalUserService.PortalProfile;
import com.ruoyi.bge.service.BgeReadService;
import com.ruoyi.bge.support.BgePathPolicy;
import com.ruoyi.bge.support.BgeProxyException;
import com.ruoyi.bge.support.BgeSafeText;
import com.ruoyi.bge.support.PortalException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartHttpServletRequest;
import org.springframework.web.util.UriUtils;

/**
 * Strict user-facing bridge. Unlike the administrator workbench proxy this
 * class never forwards a browser-controlled generic path and checks the
 * ownership ledger before every Node operation.
 */
@RestController
@RequestMapping("/portal-api")
@PreAuthorize("isAuthenticated()")
public class BgePortalController
{
    private static final Set<String> EXAMPLE_GROUPS = Set.of("cover", "original", "result");
    private final BgeEngineClient client;
    private final BgeReadService readService;
    private final BgePortalOwnershipRepository ownership;
    private final PortalUserService portalUsers;
    private final ObjectMapper objectMapper;

    public BgePortalController(BgeEngineClient client, BgeReadService readService,
            BgePortalOwnershipRepository ownership, PortalUserService portalUsers, ObjectMapper objectMapper)
    {
        this.client = client;
        this.readService = readService;
        this.ownership = ownership;
        this.portalUsers = portalUsers;
        this.objectMapper = objectMapper;
    }

    @GetMapping("/health")
    public ObjectNode health()
    {
        portalUsers.current();
        var health = readService.health();
        ObjectNode result = objectMapper.createObjectNode();
        result.put("status", health.status());
        result.put("state", health.state());
        result.put("service", health.service());
        result.put("acceptingJobs", health.acceptingJobs());
        result.put("accessMode", "portal");
        result.set("disk", objectMapper.valueToTree(health.disk()));
        return result;
    }

    @GetMapping("/api/tasks")
    public ObjectNode tasks()
    {
        PortalProfile user = portalUsers.current();
        List<TaskDetail> details = refreshOwnedTasks(user.userId());
        ArrayNode tasks = objectMapper.createArrayNode();
        String activeJobId = "";
        String activePhase = "idle";
        for (TaskDetail detail : details)
        {
            tasks.add(taskJson(detail));
            if (activeJobId.isEmpty() && isActive(detail.status()))
            {
                activeJobId = detail.id();
                activePhase = detail.progress() == null ? "running" : detail.progress().stage();
            }
        }
        ObjectNode result = objectMapper.createObjectNode();
        result.set("tasks", tasks);
        result.put("activeJobId", activeJobId);
        result.put("activePhase", activePhase == null ? "idle" : activePhase);
        return result;
    }

    @GetMapping("/api/tasks/{taskId}")
    public ObjectNode task(@PathVariable String taskId)
    {
        PortalProfile user = portalUsers.current();
        requireOwnedImage(user.userId(), taskId);
        return taskJson(readOwnedTask(taskId));
    }

    @GetMapping("/api/jobs/{taskId}")
    public ObjectNode job(@PathVariable String taskId)
    {
        PortalProfile user = portalUsers.current();
        requireOwnedImage(user.userId(), taskId);
        return taskJson(readOwnedTask(taskId));
    }

    @PostMapping(value = "/api/jobs", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ObjectNode createImageJob(MultipartHttpServletRequest request)
    {
        PortalProfile user = portalUsers.current();
        JsonNode accepted = forwardMultipartJson("/api/jobs", request);
        String jobId = requiredJobId(accepted);
        // The task id is the durable ownership boundary. Output folder names
        // may contain localized characters, so output authorization is derived
        // from an owned task instead of persisting a second identifier.
        ownership.claim(user.userId(), BgePortalOwnershipRepository.IMAGE, jobId, "");
        return taskJson(readOwnedTask(jobId));
    }

    @PostMapping("/api/jobs/{taskId}/cancel")
    public ObjectNode cancelImageJob(@PathVariable String taskId, HttpServletRequest request)
    {
        PortalProfile user = portalUsers.current();
        requireOwnedImage(user.userId(), taskId);
        forwardJson("POST", "/api/jobs/" + BgePathPolicy.encode(BgePathPolicy.identifier(taskId)) + "/cancel", request);
        return taskJson(readOwnedTask(taskId));
    }

    @DeleteMapping("/api/tasks/{taskId}")
    public ObjectNode deleteTask(@PathVariable String taskId, HttpServletRequest request)
    {
        PortalProfile user = portalUsers.current();
        String cleanTaskId = BgePathPolicy.identifier(taskId);
        requireOwnedImage(user.userId(), cleanTaskId);
        forwardJson("DELETE", "/api/tasks/" + BgePathPolicy.encode(cleanTaskId), request);
        ownership.deleteOwnedImageJob(user.userId(), cleanTaskId);
        ObjectNode result = objectMapper.createObjectNode();
        result.put("ok", true);
        result.put("taskId", cleanTaskId);
        return result;
    }

    @GetMapping("/api/outputs")
    public ObjectNode outputs()
    {
        PortalProfile user = portalUsers.current();
        List<TaskDetail> details = refreshOwnedTasks(user.userId());
        ArrayNode outputs = objectMapper.createArrayNode();
        for (TaskDetail detail : details)
        {
            if (detail.output() != null)
            {
                outputs.add(outputJson(detail.output()));
            }
        }
        ObjectNode result = objectMapper.createObjectNode();
        result.set("outputs", outputs);
        return result;
    }

    @GetMapping("/api/outputs/{outputId}")
    public ObjectNode output(@PathVariable String outputId)
    {
        PortalProfile user = portalUsers.current();
        requireOwnedOutput(user.userId(), outputId);
        return outputJson(readService.output(outputId));
    }

    @DeleteMapping("/api/outputs/{outputId}")
    public ObjectNode deleteOutput(@PathVariable String outputId, HttpServletRequest request)
    {
        PortalProfile user = portalUsers.current();
        String cleanOutputId = BgePathPolicy.identifier(outputId);
        requireOwnedOutput(user.userId(), cleanOutputId);
        forwardJson("DELETE", "/api/outputs/" + BgePathPolicy.encode(cleanOutputId), request);
        ObjectNode result = objectMapper.createObjectNode();
        result.put("ok", true);
        result.put("outputId", cleanOutputId);
        return result;
    }

    @PostMapping("/api/outputs/{outputId}/download")
    public void downloadOutput(@PathVariable String outputId, HttpServletRequest request, HttpServletResponse response)
    {
        PortalProfile user = portalUsers.current();
        String cleanOutputId = BgePathPolicy.identifier(outputId);
        requireOwnedOutput(user.userId(), cleanOutputId);
        String path = "/api/outputs/" + BgePathPolicy.encode(cleanOutputId) + "/download";
        forwardDownload(path, request, response);
    }

    @PostMapping(value = "/api/brief-expansions", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ObjectNode createBriefExpansion(MultipartHttpServletRequest request)
    {
        PortalProfile user = portalUsers.current();
        JsonNode accepted = forwardMultipartJson("/api/brief-expansions", request);
        String jobId = requiredJobId(accepted);
        ownership.claim(user.userId(), BgePortalOwnershipRepository.BRIEF, jobId, "");
        return briefJson(accepted);
    }

    @GetMapping("/api/brief-expansions/{jobId}")
    public ObjectNode briefExpansion(@PathVariable String jobId)
    {
        PortalProfile user = portalUsers.current();
        String cleanJobId = BgePathPolicy.identifier(jobId);
        if (!ownership.owns(user.userId(), BgePortalOwnershipRepository.BRIEF, cleanJobId))
        {
            throw PortalException.notFound();
        }
        return briefJson(client.getJson("/api/brief-expansions/" + BgePathPolicy.encode(cleanJobId)));
    }

    @GetMapping("/api/examples")
    public ObjectNode examples()
    {
        portalUsers.current();
        JsonNode source = client.getJson("/api/examples");
        ArrayNode examples = objectMapper.createArrayNode();
        for (JsonNode item : source.path("examples"))
        {
            ObjectNode safe = exampleJson(item, false);
            if (safe != null)
            {
                examples.add(safe);
            }
        }
        ObjectNode result = objectMapper.createObjectNode();
        result.set("examples", examples);
        return result;
    }

    @GetMapping("/api/examples/{exampleId}")
    public ObjectNode example(@PathVariable String exampleId)
    {
        portalUsers.current();
        String cleanId = BgePathPolicy.identifier(exampleId);
        ObjectNode safe = exampleJson(client.getJson("/api/examples/" + BgePathPolicy.encode(cleanId)), true);
        if (safe == null)
        {
            throw PortalException.notFound();
        }
        return safe;
    }

    @RequestMapping(value = "/outputs/**", method = RequestMethod.GET)
    public void outputAsset(HttpServletRequest request, HttpServletResponse response)
    {
        PortalProfile user = portalUsers.current();
        String[] parts = controlledPathParts(request, "/portal-api/outputs/");
        if (parts.length != 2 && parts.length != 3)
        {
            throw BgeProxyException.invalidParameter();
        }
        String outputId = BgePathPolicy.identifier(parts[0]);
        requireOwnedOutput(user.userId(), outputId);
        String group;
        String filename;
        if (parts.length == 2)
        {
            group = "overview";
            filename = BgePathPolicy.filename(parts[1], group);
        }
        else
        {
            group = BgePathPolicy.group(parts[1]);
            if ("overview".equals(group))
            {
                throw BgeProxyException.invalidParameter();
            }
            filename = BgePathPolicy.filename(parts[2], group);
        }
        try (AssetResponse asset = readService.asset(outputId, group, filename))
        {
            streamAsset(asset, response);
        }
        catch (BgeProxyException exception)
        {
            throw exception;
        }
        catch (IOException exception)
        {
            if (!response.isCommitted())
            {
                throw BgeProxyException.unavailable();
            }
        }
    }

    @RequestMapping(value = "/example-assets/**", method = RequestMethod.GET)
    public void exampleAsset(HttpServletRequest request, HttpServletResponse response)
    {
        portalUsers.current();
        String[] parts = controlledPathParts(request, "/portal-api/example-assets/");
        if (parts.length != 3 || !EXAMPLE_GROUPS.contains(parts[1]))
        {
            throw BgeProxyException.invalidParameter();
        }
        String exampleId = BgePathPolicy.identifier(parts[0]);
        int index = safeExampleIndex(parts[2]);
        try (AssetResponse asset = client.openAsset("/example-assets/" + BgePathPolicy.encode(exampleId)
                + "/" + parts[1] + "/" + index))
        {
            streamAsset(asset, response);
        }
        catch (BgeProxyException exception)
        {
            throw exception;
        }
        catch (IOException exception)
        {
            if (!response.isCommitted())
            {
                throw BgeProxyException.unavailable();
            }
        }
    }

    private List<TaskDetail> refreshOwnedTasks(Long userId)
    {
        List<TaskDetail> details = new ArrayList<>();
        for (String jobId : ownership.listOwnedJobIds(userId, BgePortalOwnershipRepository.IMAGE))
        {
            try
            {
                details.add(readService.task(jobId));
            }
            catch (BgeProxyException exception)
            {
                if (exception.getStatus().is4xxClientError())
                {
                    continue;
                }
                throw exception;
            }
        }
        return details;
    }

    private TaskDetail readOwnedTask(String rawTaskId)
    {
        String taskId = BgePathPolicy.identifier(rawTaskId);
        return readService.task(taskId);
    }

    private void requireOwnedImage(Long userId, String rawTaskId)
    {
        if (!ownership.owns(userId, BgePortalOwnershipRepository.IMAGE, rawTaskId))
        {
            throw PortalException.notFound();
        }
    }

    private void requireOwnedOutput(Long userId, String rawOutputId)
    {
        String outputId = BgePathPolicy.identifier(rawOutputId);
        for (TaskDetail detail : refreshOwnedTasks(userId))
        {
            if (detail.output() != null && outputId.equals(detail.output().id()))
            {
                return;
            }
        }
        throw PortalException.notFound();
    }

    private JsonNode forwardJson(String method, String path, HttpServletRequest request)
    {
        JsonResponse upstream = client.forwardWorkbenchJson(method, path, request.getContentType(),
                request.getHeader("X-Idempotency-Key"), requestInput(request));
        return acceptedJson(upstream);
    }

    private JsonNode forwardMultipartJson(String path, MultipartHttpServletRequest request)
    {
        JsonResponse upstream = client.forwardWorkbenchMultipartJson("POST", path,
                request.getHeader("X-Idempotency-Key"), request);
        return acceptedJson(upstream);
    }

    private JsonNode acceptedJson(JsonResponse upstream)
    {
        if (upstream.statusCode() >= 200 && upstream.statusCode() < 300)
        {
            return upstream.body();
        }
        if (upstream.statusCode() == HttpServletResponse.SC_CONFLICT)
        {
            throw PortalException.conflict("作图服务正在处理其他任务，请稍后再试。");
        }
        if (upstream.statusCode() >= 400 && upstream.statusCode() < 500)
        {
            throw PortalException.badRequest("本次作图请求未通过本地校验。");
        }
        throw BgeProxyException.invalidUpstream();
    }

    private java.io.InputStream requestInput(HttpServletRequest request)
    {
        try
        {
            return request.getInputStream();
        }
        catch (IOException exception)
        {
            throw BgeProxyException.invalidParameter();
        }
    }

    private void forwardDownload(String path, HttpServletRequest request, HttpServletResponse response)
    {
        try (WorkbenchResponse upstream = client.forwardWorkbenchRequest("POST", path, request.getContentType(),
                request.getHeader("X-Idempotency-Key"), requestInput(request)))
        {
            if (upstream.statusCode() != HttpServletResponse.SC_OK || !"application/zip".equals(upstream.contentType()))
            {
                throw PortalException.notFound();
            }
            response.setStatus(HttpServletResponse.SC_OK);
            response.setContentType(upstream.contentType());
            if (!upstream.contentDisposition().isEmpty())
            {
                response.setHeader(HttpHeaders.CONTENT_DISPOSITION, upstream.contentDisposition());
            }
            response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
            response.setHeader("X-Content-Type-Options", "nosniff");
            if (upstream.contentLength() >= 0)
            {
                response.setContentLengthLong(upstream.contentLength());
            }
            upstream.body().transferTo(response.getOutputStream());
        }
        catch (BgeProxyException | PortalException exception)
        {
            throw exception;
        }
        catch (IOException exception)
        {
            if (!response.isCommitted())
            {
                throw BgeProxyException.unavailable();
            }
        }
    }

    private ObjectNode taskJson(TaskDetail detail)
    {
        ObjectNode result = objectMapper.valueToTree(detail);
        if (detail.output() == null)
        {
            result.remove("output");
        }
        else
        {
            result.set("output", outputJson(detail.output()));
        }
        return result;
    }

    private ObjectNode outputJson(Output output)
    {
        String outputId = BgePathPolicy.identifier(output.id());
        ObjectNode result = objectMapper.createObjectNode();
        result.put("id", outputId);
        result.put("folderName", output.folderName());
        result.put("productName", output.productName());
        result.put("displayName", output.displayName());
        result.put("taskId", output.taskId());
        result.put("submittedAt", output.submittedAt());
        result.put("submittedAtLocal", output.submittedAtLocal());
        result.put("materialExists", output.materialExists());
        result.put("status", output.status());
        result.put("errorMessage", output.errorMessage());
        result.put("updatedAt", output.updatedAt());
        result.put("mainImageCount", output.mainImageCount());
        result.put("detailImageCount", output.detailImageCount());

        ObjectNode files = result.putObject("files");
        addOutputAssets(files.putArray("main"), output.files().main(), outputId, "main");
        addOutputAssets(files.putArray("detail"), output.files().detail(), outputId, "detail");
        files.put("mainOverview", output.files().mainOverview().isEmpty() ? ""
                : outputAssetUrl(outputId, "overview", output.mainImageCount() + "张主图总览.jpg"));
        files.put("detailOverview", output.files().detailOverview().isEmpty() ? ""
                : outputAssetUrl(outputId, "overview", output.detailImageCount() + "张详情页总览.jpg"));
        files.put("longDetail", output.files().longDetail().isEmpty() ? ""
                : outputAssetUrl(outputId, "overview", "详情页完整长图.jpg"));
        return result;
    }

    private void addOutputAssets(ArrayNode target, List<Asset> assets, String outputId, String group)
    {
        for (Asset asset : assets)
        {
            String filename = BgePathPolicy.filename(asset.name(), group);
            ObjectNode item = target.addObject();
            item.put("name", filename);
            item.put("url", outputAssetUrl(outputId, group, filename));
        }
    }

    private String outputAssetUrl(String outputId, String group, String filename)
    {
        String root = "/portal-api/outputs/" + BgePathPolicy.encode(outputId) + "/";
        if ("overview".equals(group))
        {
            return root + BgePathPolicy.encode(filename);
        }
        return root + group + "/" + BgePathPolicy.encode(filename);
    }

    private ObjectNode briefJson(JsonNode source)
    {
        String id = requiredJobId(source);
        ObjectNode result = objectMapper.createObjectNode();
        result.put("id", id);
        result.put("status", safeText(source, "status", 48));
        result.put("message", safeText(source, "message", 320));
        result.put("imageAnalysis", safeText(source, "imageAnalysis", 12_000));
        result.put("resultText", safeText(source, "resultText", 6_000));
        result.put("error", safeText(source, "error", 320));
        ObjectNode diagnostics = result.putObject("diagnostics");
        JsonNode sourceDiagnostics = source.path("diagnostics");
        diagnostics.put("source", BgeSafeText.value(sourceDiagnostics.path("source").asText(""), 48));
        diagnostics.put("usedFallback", sourceDiagnostics.path("usedFallback").asBoolean(false));
        diagnostics.put("reasonCode", BgeSafeText.value(sourceDiagnostics.path("reasonCode").asText(""), 80));
        diagnostics.put("reasonMessage", BgeSafeText.value(sourceDiagnostics.path("reasonMessage").asText(""), 320));
        diagnostics.put("attempts", Math.max(0, Math.min(20, sourceDiagnostics.path("attempts").asInt(0))));
        return result;
    }

    private ObjectNode exampleJson(JsonNode source, boolean includeTemplate)
    {
        String id;
        try
        {
            id = BgePathPolicy.identifier(source.path("id").asText(""));
        }
        catch (BgeProxyException exception)
        {
            return null;
        }
        ObjectNode result = objectMapper.createObjectNode();
        result.put("id", id);
        result.put("title", safeText(source, "title", 100));
        result.put("category", safeText(source, "category", 80));
        result.put("summary", safeText(source, "summary", 600));
        result.put("style", safeText(source, "style", 240));
        ArrayNode tags = result.putArray("tags");
        for (JsonNode tag : source.path("tags"))
        {
            if (tags.size() == 8)
            {
                break;
            }
            String safe = BgeSafeText.value(tag.asText(""), 40);
            if (!safe.isEmpty())
            {
                tags.add(safe);
            }
        }
        ArrayNode originals = result.putArray("originalImages");
        addExampleImages(originals, source.path("originalImages"), id, "original");
        ArrayNode images = result.putArray("resultImages");
        addExampleImages(images, source.path("resultImages"), id, "result");
        ObjectNode counts = result.putObject("counts");
        counts.put("original", originals.size());
        counts.put("result", images.size());
        JsonNode cover = source.path("cover");
        if (cover.isObject())
        {
            ObjectNode safeCover = result.putObject("cover");
            safeCover.put("name", safeText(cover, "name", 80));
            safeCover.put("url", exampleAssetUrl(id, "cover", 0));
        }
        else if (images.size() > 0)
        {
            result.set("cover", images.get(0));
        }
        else if (originals.size() > 0)
        {
            result.set("cover", originals.get(0));
        }
        if (includeTemplate)
        {
            result.put("templateText", safeText(source, "templateText", 6_000));
        }
        return result;
    }

    private void addExampleImages(ArrayNode target, JsonNode source, String exampleId, String group)
    {
        if (!source.isArray())
        {
            return;
        }
        int index = 0;
        for (JsonNode item : source)
        {
            if (index == 20)
            {
                break;
            }
            ObjectNode image = target.addObject();
            image.put("name", safeText(item, "name", 100));
            image.put("kind", safeText(item, "kind", 80));
            image.put("url", exampleAssetUrl(exampleId, group, index));
            index++;
        }
    }

    private String exampleAssetUrl(String exampleId, String group, int index)
    {
        return "/portal-api/example-assets/" + BgePathPolicy.encode(exampleId) + "/" + group + "/" + index;
    }

    private String requiredJobId(JsonNode source)
    {
        String id = source.path("id").asText(source.path("taskId").asText(""));
        return BgePathPolicy.identifier(id);
    }

    private String safeText(JsonNode source, String field, int maximumLength)
    {
        return BgeSafeText.value(source.path(field).asText(""), maximumLength);
    }

    private int safeExampleIndex(String raw)
    {
        if (raw == null || !raw.matches("(?:0|[1-9][0-9]?)"))
        {
            throw BgeProxyException.invalidParameter();
        }
        int index = Integer.parseInt(raw);
        if (index > 19)
        {
            throw BgeProxyException.invalidParameter();
        }
        return index;
    }

    private String[] controlledPathParts(HttpServletRequest request, String relativePrefix)
    {
        String prefix = request.getContextPath() + relativePrefix;
        String uri = request.getRequestURI();
        if (uri == null || !uri.startsWith(prefix))
        {
            throw BgeProxyException.invalidParameter();
        }
        String raw = uri.substring(prefix.length());
        if (raw.isBlank() || raw.contains("//") || raw.contains("\\") || raw.contains("\r") || raw.contains("\n"))
        {
            throw BgeProxyException.invalidParameter();
        }
        String[] encoded = raw.split("/", -1);
        String[] decoded = new String[encoded.length];
        for (int index = 0; index < encoded.length; index++)
        {
            decoded[index] = UriUtils.decode(encoded[index], StandardCharsets.UTF_8);
        }
        return decoded;
    }

    private void streamAsset(AssetResponse asset, HttpServletResponse response) throws IOException
    {
        response.setStatus(HttpServletResponse.SC_OK);
        response.setContentType(asset.contentType());
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        if (asset.contentLength() >= 0)
        {
            response.setContentLengthLong(asset.contentLength());
        }
        asset.body().transferTo(response.getOutputStream());
    }

    private boolean isActive(String status)
    {
        return Set.of("receiving", "submitting", "queued", "running", "canceling").contains(status);
    }
}
