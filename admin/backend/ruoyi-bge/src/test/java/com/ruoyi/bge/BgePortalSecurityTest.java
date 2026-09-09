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
import com.ruoyi.bge.service.BgeReadService;
import com.ruoyi.bge.support.PortalException;
import com.ruoyi.common.core.domain.entity.SysUser;
import com.ruoyi.framework.web.service.SysLoginService;
import com.ruoyi.framework.web.service.TokenService;
import com.ruoyi.system.service.ISysRoleService;
import com.ruoyi.system.service.ISysUserService;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.mock.web.MockMultipartHttpServletRequest;

class BgePortalSecurityTest
{
    @Test
    void registrationUsesOnlyTheDedicatedPortalRole() throws Exception
    {
        ISysUserService users = mock(ISysUserService.class);
        ISysRoleService roles = mock(ISysRoleService.class);
        SysLoginService login = mock(SysLoginService.class);
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.query(any(String.class), any(org.springframework.jdbc.core.ResultSetExtractor.class),
                eq(PortalUserService.PORTAL_ROLE))).thenReturn(123L);
        when(users.selectUserByUserName("portal_test")).thenReturn(null);
        when(users.insertUser(any(SysUser.class))).thenAnswer(invocation -> {
            SysUser user = invocation.getArgument(0);
            user.setUserId(456L);
            return 1;
        });

        PortalUserService service = new PortalUserService(users, roles, login, mock(TokenService.class), jdbc);
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
        when(users.current()).thenReturn(new PortalProfile(22L, "portal_a", "用户 A"));
        when(ownership.owns(22L, BgePortalOwnershipRepository.IMAGE, "task-other")).thenReturn(false);
        BgePortalController controller = new BgePortalController(client, reads, ownership, users, new ObjectMapper());

        PortalException failure = assertThrows(PortalException.class, () -> controller.task("task-other"));
        assertEquals(404, failure.getStatus().value());
        verifyNoInteractions(reads);
        verify(client, never()).getJson(any(String.class));
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
        when(users.current()).thenReturn(new PortalProfile(22L, "portal_a", "用户 A"));
        when(client.forwardWorkbenchMultipartJson(eq("POST"), eq("/api/brief-expansions"),
                any(), same(request))).thenReturn(new BgeEngineClient.JsonResponse(202, accepted));
        BgePortalController controller = new BgePortalController(client, reads, ownership, users, mapper);

        assertEquals("brief-1", controller.createBriefExpansion(request).path("id").asText());
        verify(ownership).claim(22L, BgePortalOwnershipRepository.BRIEF, "brief-1", "");
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
        when(users.current()).thenReturn(new PortalProfile(22L, "portal_a", "用户 A"));
        when(ownership.owns(22L, BgePortalOwnershipRepository.BRIEF, "brief-vision-1")).thenReturn(true);
        when(client.getJson("/api/brief-expansions/brief-vision-1")).thenReturn(completed);
        BgePortalController controller = new BgePortalController(client, reads, ownership, users, mapper);

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
                false, false, "", "", true, 0, null, List.of(), output);
        when(users.current()).thenReturn(new PortalProfile(22L, "portal_a", "用户 A"));
        when(ownership.listOwnedJobIds(22L, BgePortalOwnershipRepository.IMAGE)).thenReturn(List.of("task-own"));
        when(reads.task("task-own")).thenReturn(task);
        when(reads.output("output-own")).thenReturn(output);
        BgePortalController controller = new BgePortalController(client, reads, ownership, users, new ObjectMapper());

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
