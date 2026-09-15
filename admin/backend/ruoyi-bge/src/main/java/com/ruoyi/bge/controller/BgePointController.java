package com.ruoyi.bge.controller;

import com.ruoyi.bge.points.BgePointAdminService;
import com.ruoyi.bge.points.BgePointService;
import com.ruoyi.common.core.domain.AjaxResult;
import com.ruoyi.common.utils.SecurityUtils;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Administrator point accounts, pricing and recharge review. */
@RestController
@RequestMapping("/bge/points")
public class BgePointController
{
    private static final String LIST = "@ss.hasPermi('bge:points:list')";
    private static final String ADJUST = "@ss.hasPermi('bge:points:adjust')";
    private static final String REVIEW = "@ss.hasPermi('bge:points:recharge:review')";
    private static final String PRICE_MANAGE = "@ss.hasPermi('bge:points:price:manage')";
    private final BgePointService points;
    private final BgePointAdminService admin;

    public BgePointController(BgePointService points, BgePointAdminService admin)
    {
        this.points = points;
        this.admin = admin;
    }

    @PreAuthorize(LIST)
    @GetMapping("/summary")
    public AjaxResult summary()
    {
        return AjaxResult.success(admin.summary());
    }

    @PreAuthorize(LIST)
    @GetMapping("/users")
    public AjaxResult users(@RequestParam(defaultValue = "") String username,
            @RequestParam(defaultValue = "1") int pageNum, @RequestParam(defaultValue = "20") int pageSize)
    {
        return AjaxResult.success(points.adminAccounts(username, pageNum, pageSize));
    }

    @PreAuthorize(ADJUST)
    @PostMapping("/users/{userId}/adjust")
    public AjaxResult adjust(@PathVariable long userId, @RequestBody Adjustment request)
    {
        return AjaxResult.success(points.adjust(userId, request.change(), request.note(),
                request.idempotencyKey(), SecurityUtils.getUserId()));
    }

    @PreAuthorize(LIST)
    @GetMapping("/ledger")
    public AjaxResult ledger(@RequestParam(defaultValue = "") String username,
            @RequestParam(defaultValue = "") String eventType,
            @RequestParam(defaultValue = "") String from,
            @RequestParam(defaultValue = "") String to,
            @RequestParam(defaultValue = "1") int pageNum,
            @RequestParam(defaultValue = "20") int pageSize)
    {
        return AjaxResult.success(admin.ledgers(username, eventType, from, to, pageNum, pageSize));
    }

    @PreAuthorize(LIST)
    @GetMapping("/charges")
    public AjaxResult charges(@RequestParam(defaultValue = "") String username,
            @RequestParam(defaultValue = "") String taskId,
            @RequestParam(defaultValue = "") String status,
            @RequestParam(defaultValue = "1") int pageNum,
            @RequestParam(defaultValue = "20") int pageSize)
    {
        return AjaxResult.success(admin.charges(username, taskId, status, pageNum, pageSize));
    }

    @PreAuthorize(LIST)
    @GetMapping("/prices")
    public AjaxResult prices()
    {
        return AjaxResult.success(points.prices());
    }

    @PreAuthorize(PRICE_MANAGE)
    @PutMapping("/prices")
    public AjaxResult updatePrices(@RequestBody PriceTableUpdate request)
    {
        return AjaxResult.success(admin.updatePrices(request.idempotencyKey(), request.reason(),
                SecurityUtils.getUsername(), request.prices()));
    }

    @PreAuthorize(LIST)
    @GetMapping("/price-history")
    public AjaxResult priceHistory()
    {
        return AjaxResult.success(admin.priceHistory());
    }

    @PreAuthorize(LIST)
    @GetMapping("/recharges")
    public AjaxResult recharges(@RequestParam(defaultValue = "") String status,
            @RequestParam(defaultValue = "1") int pageNum,
            @RequestParam(defaultValue = "20") int pageSize)
    {
        return AjaxResult.success(admin.recharges(status, pageNum, pageSize));
    }

    @PreAuthorize(REVIEW)
    @PostMapping("/recharges/{requestId}/review")
    public AjaxResult review(@PathVariable long requestId, @RequestBody Review request)
    {
        return AjaxResult.success(points.reviewRecharge(requestId, request.approve(), request.note(), SecurityUtils.getUserId()));
    }

    @PreAuthorize(LIST)
    @GetMapping("/reconciliation")
    public AjaxResult reconciliation()
    {
        return AjaxResult.success(admin.reconciliation());
    }

    public record Adjustment(long change, String note, String idempotencyKey) {}
    public record PriceTableUpdate(String idempotencyKey, String reason,
            java.util.List<BgePointAdminService.PriceInput> prices) {}
    public record Review(boolean approve, String note) {}
}
