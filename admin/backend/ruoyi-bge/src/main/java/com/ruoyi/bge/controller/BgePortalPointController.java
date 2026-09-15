package com.ruoyi.bge.controller;

import com.ruoyi.bge.points.BgePointService;
import com.ruoyi.bge.portal.PortalUserService;
import com.ruoyi.common.core.domain.AjaxResult;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Authenticated user point balance, ledger and recharge requests. */
@RestController
@RequestMapping("/portal-api/points")
@PreAuthorize("isAuthenticated()")
public class BgePortalPointController
{
    private final PortalUserService users;
    private final BgePointService points;

    public BgePortalPointController(PortalUserService users, BgePointService points)
    {
        this.users = users;
        this.points = points;
    }

    @GetMapping
    public AjaxResult summary()
    {
        return AjaxResult.success(points.portalPoints(users.current().userId()));
    }

    @PostMapping("/recharges")
    public AjaxResult recharge(@RequestBody RechargeRequest request)
    {
        return AjaxResult.success(points.requestRecharge(users.current().userId(), request.points(), request.note()));
    }

    public record RechargeRequest(int points, String note) {}
}
