package com.ruoyi.bge;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.same;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import java.lang.reflect.Method;
import java.util.List;
import java.util.Set;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ruoyi.bge.client.BgeEngineClient;
import com.ruoyi.bge.controller.BgePortalController;
import com.ruoyi.bge.domain.BgeDtos.Output;
import com.ruoyi.bge.domain.BgeDtos.OutputFiles;
import com.ruoyi.bge.domain.BgeDtos.TaskDetail;
import com.ruoyi.bge.portal.BgePortalOwnershipRepository;
import com.ruoyi.bge.portal.PortalUserService;
import com.ruoyi.bge.portal.PortalUserService.PortalProfile;
import com.ruoyi.bge.portal.PortalUserService.Registration;
import com.ruoyi.bge.portal.PortalUserService.Login;
import com.ruoyi.bge.points.BgePointService;
import com.ruoyi.bge.points.BgePointService.Account;
import com.ruoyi.bge.points.BgePointService.Reservation;
import com.ruoyi.bge.service.BgeReadService;
import com.ruoyi.bge.support.BgeProxyException;
import com.ruoyi.bge.support.PortalException;
import com.ruoyi.common.core.domain.entity.SysUser;
import com.ruoyi.framework.web.service.SysLoginService;
import com.ruoyi.framework.web.service.TokenService;
import com.ruoyi.system.service.ISysUserService;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.mock.web.MockMultipartHttpServletRequest;
import jakarta.servlet.http.HttpServletRequest;

class BgePortalSecurityTest
{
    @Test
    void enabledRuoYiUserCanLogInWithoutThePortalRole()
    {
        ISysUserService users = mock(ISysUserService.class);
        SysLoginService login = mock(SysLoginService.class);
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        BgePointService points = mock(BgePointService.class);
        SysUser existing = new SysUser();
        existing.setUserId(88L);
        existing.setUserName("returning_user");
        existing.setNickName("回访用户");
        when(login.login("returning_user", "correct-password", "1234", "captcha-id"))
                .thenReturn("portal-token");
        when(users.selectUserByUserName("returning_user")).thenReturn(existing);
        when(points.account(88L)).thenReturn(new Account(88L, 30, 30, 0, ""));
        PortalUserService service = new PortalUserService(users, login, mock(TokenService.class), jdbc, points);

        var authenticated = service.login(new Login("returning_user", "correct-password", "1234", "captcha-id"));

        assertEquals("portal-token", authenticated.token());
        assertEquals(88L, authenticated.user().userId());
        assertEquals(30, authenticated.user().pointsBalance());
        verifyNoInteractions(jdbc);
    }

    @Test
    void registrationUsesOnlyTheDedicatedPortalRole() throws Exception
    {
        ISysUserService users = mock(ISysUserService.class);
        SysLoginService login = mock(SysLoginService.class);
        BgePointService points = mock(BgePointService.class);
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.query(any(String.class), any(org.springframework.jdbc.core.ResultSetExtractor.class),
                eq(PortalUserService.PORTAL_ROLE))).thenReturn(123L);
        when(users.selectUserByUserName("portal_test")).thenReturn(null);
        when(users.insertUser(any(SysUser.class))).thenAnswer(invocation -> {
            SysUser user = invocation.getArgument(0);
            user.setUserId(456L);
            return 1;
        });
        when(points.account(456L)).thenReturn(new Account(456L, 30, 30, 0, ""));

        PortalUserService service = new PortalUserService(users, login, mock(TokenService.class), jdbc, points);
        service.register(new Registration("portal_test", "测试用户", "123456", "123456", "", ""));

        ArgumentCaptor<SysUser> created = ArgumentCaptor.forClass(SysUser.class);
        verify(users).insertUser(created.capture());
        assertEquals("portal_test", created.getValue().getUserName());
        assertArrayEquals(new Long[] { 123L }, created.getValue().getRoleIds());
        verify(login).validateCaptcha("portal_test", "", "");
    }

    @Test
    void anotherUsersTaskIsRejectedBeforeTheEngineIsRead() throws Exception
    {
        BgeEngineClient client = mock(BgeEngineClient.class);
        BgeReadService reads = mock(BgeReadService.class);
        BgePortalOwnershipRepository ownership = mock(BgePortalOwnershipRepository.class);
        PortalUserService users = mock(PortalUserService.class);
        when(users.current()).thenReturn(new PortalProfile(22L, "portal_a", "用户 A", 30));
        when(ownership.owns(22L, BgePortalOwnershipRepository.IMAGE, "task-other")).thenReturn(false);
        BgePortalController controller = new BgePortalController(client, reads, ownership, users,
                mock(BgePointService.class), new ObjectMapper());

        PortalException failure = assertThrows(PortalException.class, () -> controller.task("task-other"));
        assertEquals(404, failure.getStatus().value());
        verifyNoInteractions(reads);
        verify(client, never()).getJson(any(String.class));
    }

    @Test
    void anotherUsersTaskCannotBeRetriedThroughThePortal()
    {
        BgeEngineClient client = mock(BgeEngineClient.class);
        BgeReadService reads = mock(BgeReadService.class);
        BgePortalOwnershipRepository ownership = mock(BgePortalOwnershipRepository.class);
        PortalUserService users = mock(PortalUserService.class);
        when(users.current()).thenReturn(new PortalProfile(22L, "portal_a", "用户 A", 30));
        when(ownership.owns(22L, BgePortalOwnershipRepository.IMAGE, "task-other")).thenReturn(false);
        BgePortalController controller = new BgePortalController(client, reads, ownership, users,
                mock(BgePointService.class), new ObjectMapper());

        PortalException failure = assertThrows(PortalException.class,
                () -> controller.retryImageJob("task-other", mock(HttpServletRequest.class)));

        assertEquals(404, failure.getStatus().value());
        verifyNoInteractions(reads);
        verify(client, never()).forwardWorkbenchJson(any(String.class), any(String.class),
                any(), any(), any());
    }

    @Test
    void portalBriefExpansionForwardsTheParsedMultipartRequest()
    {
        BgeEngineClient client = mock(BgeEngineClient.class);
        BgeReadService reads = mock(BgeReadService.class);
        BgePortalOwnershipRepository ownership = mock(BgePortalOwnershipRepository.class);
        PortalUserService users = mock(PortalUserService.class);
        ObjectMapper mapper = new ObjectMapper();
        MockMultipartHttpServletRequest request = new MockMultipartHttpServletRequest();
        request.addParameter("productName", "机械臂");
        request.addFile(new MockMultipartFile("referenceImages", "robot.png", "image/png", new byte[] { 1 }));
        var accepted = mapper.createObjectNode();
        accepted.put("id", "brief-1");
        accepted.put("status", "queued");
        when(users.current()).thenReturn(new PortalProfile(22L, "portal_a", "用户 A", 30));
        when(client.forwardWorkbenchMultipartJson(eq("POST"), eq("/api/brief-expansions"),
                any(), same(request))).thenReturn(new BgeEngineClient.JsonResponse(202, accepted));
        BgePortalController controller = new BgePortalController(client, reads, ownership, users,
                mock(BgePointService.class), mapper);

        assertEquals("brief-1", controller.createBriefExpansion(request).path("id").asText());
        verify(ownership).claim(22L, BgePortalOwnershipRepository.BRIEF, "brief-1", "");
    }

    @Test
    void rejectedSubmissionReleasesReservedPoints()
    {
        BgeEngineClient client = mock(BgeEngineClient.class);
        BgePointService points = mock(BgePointService.class);
        PortalUserService users = mock(PortalUserService.class);
        MockMultipartHttpServletRequest request = imageJobRequest();
        when(users.current()).thenReturn(new PortalProfile(22L, "portal_a", "用户 A", 30));
        when(points.reserveGeneration(22L, "request-key-rejected", "compact-1-2", "1k"))
                .thenReturn(new Reservation(7L, "request-key-rejected", 3, 27));
        when(client.forwardWorkbenchMultipartJson(eq("POST"), eq("/api/jobs"),
                eq("request-key-rejected"), same(request))).thenThrow(BgeProxyException.invalidParameter());
        BgePortalController controller = new BgePortalController(client, mock(BgeReadService.class),
                mock(BgePortalOwnershipRepository.class), users, points, new ObjectMapper());

        assertThrows(BgeProxyException.class, () -> controller.createImageJob(request));

        verify(points).releaseSubmission(22L, 7L);
    }

    @Test
    void uncertainSubmissionKeepsReservationForIdempotentRecovery()
    {
        BgeEngineClient client = mock(BgeEngineClient.class);
        BgePointService points = mock(BgePointService.class);
        PortalUserService users = mock(PortalUserService.class);
        MockMultipartHttpServletRequest request = imageJobRequest();
        request.removeHeader("X-Idempotency-Key");
        request.addHeader("X-Idempotency-Key", "request-key-uncertain");
        when(users.current()).thenReturn(new PortalProfile(22L, "portal_a", "用户 A", 30));
        when(points.reserveGeneration(22L, "request-key-uncertain", "compact-1-2", "1k"))
                .thenReturn(new Reservation(8L, "request-key-uncertain", 3, 27));
        when(client.forwardWorkbenchMultipartJson(eq("POST"), eq("/api/jobs"),
                eq("request-key-uncertain"), same(request))).thenThrow(BgeProxyException.unavailable());
        BgePortalController controller = new BgePortalController(client, mock(BgeReadService.class),
                mock(BgePortalOwnershipRepository.class), users, points, new ObjectMapper());

        assertThrows(BgeProxyException.class, () -> controller.createImageJob(request));

        verify(points, never()).releaseSubmission(anyLong(), anyLong());
    }

    @Test
    void rejectedRetryReleasesOnlyTheNewReservation()
    {
        RetryFixture fixture = retryFixture(BgeProxyException.invalidParameter());

        assertThrows(BgeProxyException.class,
                () -> fixture.controller().retryImageJob("task-retry", fixture.request()));

        verify(fixture.points(), times(2)).settleTask(22L, "task-retry", 1);
    }

    @Test
    void uncertainRetryKeepsTheNewReservationForRecovery()
    {
        RetryFixture fixture = retryFixture(BgeProxyException.unavailable());

        assertThrows(BgeProxyException.class,
                () -> fixture.controller().retryImageJob("task-retry", fixture.request()));

        verify(fixture.points()).settleTask(22L, "task-retry", 1);
    }

    private RetryFixture retryFixture(BgeProxyException failure)
    {
        BgeEngineClient client = mock(BgeEngineClient.class);
        BgeReadService reads = mock(BgeReadService.class);
        BgePortalOwnershipRepository ownership = mock(BgePortalOwnershipRepository.class);
        PortalUserService users = mock(PortalUserService.class);
        BgePointService points = mock(BgePointService.class);
        HttpServletRequest request = mock(HttpServletRequest.class);
        Output output = new Output("output-retry", "output-retry", "", "", "task-retry", "", "", true,
                "failed", "", "", "1k", "1K 快速", 1, 2,
                new OutputFiles(List.of(new com.ruoyi.bge.domain.BgeDtos.Asset("main.png", "/main.png")),
                        List.of(), "", "", ""));
        TaskDetail task = new TaskDetail("task-retry", "task-retry", "", "output-retry", "failed", "", null, null,
                "", "", "", 1, "", "", "", "compact-1-2", "ecommerce-standard", "1k", "1K 快速", 1, 2,
                false, false, "", "", true, true, 0, null, List.of(), output);
        when(users.current()).thenReturn(new PortalProfile(22L, "portal_a", "用户 A", 30));
        when(ownership.owns(22L, BgePortalOwnershipRepository.IMAGE, "task-retry")).thenReturn(true);
        when(reads.task("task-retry")).thenReturn(task);
        when(points.reserveRetry(22L, "task-retry", "compact-1-2", "1k", 3, 1))
                .thenReturn(new Reservation(9L, "request-key-retry", 2, 28));
        when(client.forwardWorkbenchJson(eq("POST"), eq("/api/jobs/task-retry/retry"),
                any(), any(), any())).thenThrow(failure);
        return new RetryFixture(new BgePortalController(client, reads, ownership, users, points,
                new ObjectMapper()), points, request);
    }

    private record RetryFixture(BgePortalController controller, BgePointService points, HttpServletRequest request) {}

    private MockMultipartHttpServletRequest imageJobRequest()
    {
        MockMultipartHttpServletRequest request = new MockMultipartHttpServletRequest();
        request.addHeader("X-Idempotency-Key", "request-key-rejected");
        request.addParameter("generationProfileId", "compact-1-2");
        request.addParameter("imageResolutionId", "1k");
        request.addFile(new MockMultipartFile("referenceImages", "product.png", "image/png", new byte[] { 1 }));
        return request;
    }

    @Test
    void portalBriefExpansionReturnsTheOwnedImageAnalysis()
    {
        BgeEngineClient client = mock(BgeEngineClient.class);
        BgeReadService reads = mock(BgeReadService.class);
        BgePortalOwnershipRepository ownership = mock(BgePortalOwnershipRepository.class);
        PortalUserService users = mock(PortalUserService.class);
        ObjectMapper mapper = new ObjectMapper();
        var completed = mapper.createObjectNode();
        completed.put("id", "brief-vision-1");
        completed.put("status", "done");
        completed.put("imageAnalysis", "深蓝折叠伞，带格纹伞缘、束带和腕带。");
        when(users.current()).thenReturn(new PortalProfile(22L, "portal_a", "用户 A", 30));
        when(ownership.owns(22L, BgePortalOwnershipRepository.BRIEF, "brief-vision-1")).thenReturn(true);
        when(client.getJson("/api/brief-expansions/brief-vision-1")).thenReturn(completed);
        BgePortalController controller = new BgePortalController(client, reads, ownership, users,
                mock(BgePointService.class), mapper);

        var response = controller.briefExpansion("brief-vision-1");

        assertEquals("深蓝折叠伞，带格纹伞缘、束带和腕带。", response.path("imageAnalysis").asText());
    }

    @Test
    void everyPortalApiMethodRequiresAnAuthenticatedPrincipal() throws Exception
    {
        PreAuthorize controllerGate = BgePortalController.class.getAnnotation(PreAuthorize.class);
        assertEquals("isAuthenticated()", controllerGate.value());
        Method task = BgePortalController.class.getDeclaredMethod("task", String.class);
        assertEquals("/api/tasks/{taskId}", task.getAnnotation(GetMapping.class).value()[0]);
    }

    @Test
    void outputOwnershipIsDerivedFromAnOwnedTaskRatherThanAStoredOutputId()
    {
        BgeEngineClient client = mock(BgeEngineClient.class);
        BgeReadService reads = mock(BgeReadService.class);
        BgePortalOwnershipRepository ownership = mock(BgePortalOwnershipRepository.class);
        PortalUserService users = mock(PortalUserService.class);
        Output output = new Output("output-own", "output-own", "", "", "task-own", "", "", true,
                "completed", "", "", "2k", "2K 标准", 5, 8,
                new OutputFiles(List.of(), List.of(), "", "", ""));
        TaskDetail task = new TaskDetail("task-own", "task-own", "", "", "completed", "", null, null,
                "", "", "", 0, "", "", "", "standard-5-8", "ecommerce-standard", "2k", "2K 标准", 5, 8,
                false, false, "", "", true, false, 0, null, List.of(), output);
        when(users.current()).thenReturn(new PortalProfile(22L, "portal_a", "用户 A", 30));
        when(ownership.listOwnedJobIds(22L, BgePortalOwnershipRepository.IMAGE)).thenReturn(List.of("task-own"));
        when(reads.task("task-own")).thenReturn(task);
        when(reads.output("output-own")).thenReturn(output);
        BgePortalController controller = new BgePortalController(client, reads, ownership, users,
                mock(BgePointService.class), new ObjectMapper());

        var outputJson = controller.output("output-own");
        assertEquals("output-own", outputJson.path("id").asText());
        assertEquals(5, outputJson.path("mainImageCount").asInt());
        assertEquals(8, outputJson.path("detailImageCount").asInt());
        verify(ownership, never()).ownsOutput(anyLong(), any(String.class));

        PortalException failure = assertThrows(PortalException.class, () -> controller.output("output-other"));
        assertEquals(404, failure.getStatus().value());
        assertTrue(failure.getMessage().contains("未找到"));
        verify(reads, never()).output("output-other");
    }
}
