package com.ruoyi.bge.points;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.sql.PreparedStatement;
import com.ruoyi.bge.support.PortalException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Transactional point accounts, task billing and reviewed recharge requests. */
@Service
public class BgePointService
{
    public static final int WELCOME_POINTS = 30;
    private static final Set<Integer> RECHARGE_PACKAGES = Set.of(50, 100, 300, 500);
    private static final Map<String, Profile> PROFILES = profiles();
    private static final Map<String, String> RESOLUTIONS = Map.of(
            "1k", "1K 快速", "2k", "2K 标准", "4k", "4K 超清");

    private final JdbcTemplate jdbc;

    public BgePointService(JdbcTemplate jdbc)
    {
        this.jdbc = jdbc;
    }

    @Transactional
    public Account account(long userId)
    {
        ensureAccount(userId);
        return lockedAccount(userId, false);
    }

    public List<Price> prices()
    {
        return jdbc.query("SELECT generation_profile_id, image_resolution_id, points "
                        + "FROM bge_point_price ORDER BY CASE generation_profile_id "
                        + "WHEN 'compact-1-2' THEN 0 WHEN 'compact-2-3' THEN 1 WHEN 'compact-3-4' THEN 2 ELSE 3 END, "
                        + "CASE image_resolution_id WHEN '1k' THEN 0 WHEN '2k' THEN 1 ELSE 2 END",
                (rs, row) -> price(rs.getString(1), rs.getString(2), rs.getInt(3)));
    }

    @Transactional
    public PortalPoints portalPoints(long userId)
    {
        Account current = account(userId);
        List<Ledger> ledger = jdbc.query("SELECT ledger_id, change_amount, balance_after, event_type, description, created_at "
                        + "FROM bge_point_ledger WHERE user_id = ? ORDER BY ledger_id DESC LIMIT 50",
                (rs, row) -> new Ledger(rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getString(4),
                        rs.getString(5), rs.getTimestamp(6).toLocalDateTime().toString()), userId);
        List<Recharge> recharges = jdbc.query("SELECT request_id, points, status, user_note, review_note, requested_at, reviewed_at "
                        + "FROM bge_recharge_request WHERE user_id = ? ORDER BY request_id DESC LIMIT 20",
                (rs, row) -> new Recharge(rs.getLong(1), userId, "", "", rs.getInt(2), rs.getString(3),
                        rs.getString(4), rs.getString(5), rs.getTimestamp(6).toLocalDateTime().toString(),
                        rs.getTimestamp(7) == null ? "" : rs.getTimestamp(7).toLocalDateTime().toString()), userId);
        return new PortalPoints(current, prices(), ledger, recharges, RECHARGE_PACKAGES.stream().sorted().toList());
    }

    @Transactional
    public Recharge requestRecharge(long userId, int points, String note)
    {
        ensureAccount(userId);
        if (!RECHARGE_PACKAGES.contains(points))
        {
            throw PortalException.badRequest("请选择页面提供的充值积分档位。");
        }
        String safeNote = safeText(note, 200);
        long id = insertGenerated("request_id",
                "INSERT INTO bge_recharge_request (user_id, points, user_note) VALUES (?, ?, ?)",
                userId, points, safeNote);
        return recharge(id);
    }

    @Transactional
    public Reservation reserveGeneration(long userId, String requestKey, String profileId, String resolutionId)
    {
        String key = requestKey(requestKey);
        Price selected = quote(profileId, resolutionId);
        ensureAccount(userId);
        List<Charge> existing = jdbc.query("SELECT charge_id, request_key, task_id, user_id, generation_profile_id, "
                        + "image_resolution_id, expected_images, baseline_images, quoted_points, reserved_points, "
                        + "charged_points, delivered_images, status, reservation_round FROM bge_point_charge "
                        + "WHERE request_key = ? FOR UPDATE", this::charge, key);
        if (!existing.isEmpty())
        {
            Charge charge = existing.get(0);
            if (charge.userId() != userId || !charge.profileId().equals(selected.generationProfileId())
                    || !charge.resolutionId().equals(selected.imageResolutionId()))
            {
                throw PortalException.conflict("这次提交标识已用于其他作图配置，请重新提交。");
            }
            if (!"released".equals(charge.status()))
            {
                return new Reservation(charge.chargeId(), charge.requestKey(), charge.quotedPoints(),
                        accountBalance(userId));
            }
            debit(userId, charge.quotedPoints());
            int round = charge.reservationRound() + 1;
            jdbc.update("UPDATE bge_point_charge SET reserved_points = quoted_points, charged_points = 0, "
                            + "delivered_images = 0, status = 'reserved', reservation_round = ?, settled_at = NULL WHERE charge_id = ?",
                    round, charge.chargeId());
            ledger(userId, -charge.quotedPoints(), "generation_reserve",
                    "generation-reserve:" + key + ":" + round, "作图任务积分冻结", null);
            return new Reservation(charge.chargeId(), key, charge.quotedPoints(), accountBalance(userId));
        }

        debit(userId, selected.points());
        try
        {
            long chargeId = insertGenerated("charge_id",
                    "INSERT INTO bge_point_charge (request_key, user_id, generation_profile_id, image_resolution_id, "
                            + "expected_images, quoted_points, reserved_points) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    key, userId, selected.generationProfileId(), selected.imageResolutionId(),
                    selected.imageCount(), selected.points(), selected.points());
            ledger(userId, -selected.points(), "generation_reserve", "generation-reserve:" + key + ":1",
                    selected.profileLabel() + " / " + selected.resolutionLabel(), null);
            return new Reservation(chargeId, key, selected.points(), accountBalance(userId));
        }
        catch (DuplicateKeyException exception)
        {
            throw PortalException.conflict("该作图请求正在结算，请稍后查看任务列表。");
        }
    }

    @Transactional
    public Reservation reserveRetry(long userId, String taskId, String profileId, String resolutionId,
            int expectedImages, int deliveredImages)
    {
        String cleanTaskId = identifier(taskId);
        ensureAccount(userId);
        List<Charge> charges = chargesByTask(cleanTaskId, true);
        if (charges.isEmpty())
        {
            Price selected = quote(profileId, resolutionId);
            int missing = Math.max(0, expectedImages - deliveredImages);
            if (missing == 0)
            {
                return new Reservation(0, "", 0, accountBalance(userId));
            }
            int missingCost = proportional(selected.points(), missing, Math.max(1, expectedImages));
            debit(userId, missingCost);
            String key = "legacy-retry:" + cleanTaskId;
            long id = insertGenerated("charge_id",
                    "INSERT INTO bge_point_charge (request_key, task_id, user_id, generation_profile_id, image_resolution_id, "
                            + "expected_images, baseline_images, quoted_points, reserved_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    key, cleanTaskId, userId, selected.generationProfileId(), selected.imageResolutionId(),
                    missing, deliveredImages, missingCost, missingCost);
            ledger(userId, -missingCost, "generation_retry", "generation-retry:" + cleanTaskId + ":" + deliveredImages,
                    "补齐缺图积分冻结", null);
            return new Reservation(id, key, missingCost, accountBalance(userId));
        }
        Charge charge = charges.get(0);
        if (charge.userId() != userId)
        {
            throw PortalException.notFound();
        }
        if ("reserved".equals(charge.status()))
        {
            return new Reservation(charge.chargeId(), charge.requestKey(), charge.reservedPoints(), accountBalance(userId));
        }
        int remaining = Math.max(0, charge.quotedPoints() - charge.chargedPoints());
        if (remaining == 0)
        {
            return new Reservation(charge.chargeId(), charge.requestKey(), 0, accountBalance(userId));
        }
        debit(userId, remaining);
        int round = charge.reservationRound() + 1;
        jdbc.update("UPDATE bge_point_charge SET reserved_points = quoted_points, status = 'reserved', "
                        + "reservation_round = ?, settled_at = NULL WHERE charge_id = ?", round, charge.chargeId());
        ledger(userId, -remaining, "generation_retry",
                "generation-retry:" + cleanTaskId + ":" + round, "补齐缺图积分冻结", null);
        return new Reservation(charge.chargeId(), charge.requestKey(), remaining, accountBalance(userId));
    }

    @Transactional
    public void bindTask(long userId, long chargeId, String taskId)
    {
        String cleanTaskId = identifier(taskId);
        int updated = jdbc.update("UPDATE bge_point_charge SET task_id = ? WHERE charge_id = ? AND user_id = ? "
                        + "AND (task_id IS NULL OR task_id = ?)", cleanTaskId, chargeId, userId, cleanTaskId);
        if (updated != 1)
        {
            throw PortalException.conflict("积分订单与作图任务关联失败，请刷新任务列表。");
        }
    }

    @Transactional
    public void releaseSubmission(long userId, long chargeId)
    {
        List<Charge> charges = jdbc.query("SELECT charge_id, request_key, task_id, user_id, generation_profile_id, "
                        + "image_resolution_id, expected_images, baseline_images, quoted_points, reserved_points, "
                        + "charged_points, delivered_images, status, reservation_round FROM bge_point_charge "
                        + "WHERE charge_id = ? FOR UPDATE", this::charge, chargeId);
        if (charges.isEmpty()) return;
        Charge charge = charges.get(0);
        if (charge.userId() != userId || !"reserved".equals(charge.status()) || charge.taskId() != null) return;
        refund(userId, charge.reservedPoints());
        jdbc.update("UPDATE bge_point_charge SET reserved_points = 0, status = 'released', settled_at = CURRENT_TIMESTAMP "
                + "WHERE charge_id = ?", chargeId);
        ledger(userId, charge.reservedPoints(), "generation_release",
                "generation-release:" + charge.requestKey() + ":" + charge.reservationRound(),
                "作图请求未被接收，积分已退回", null);
    }

    @Transactional
    public void settleTask(long userId, String taskId, int deliveredImages)
    {
        List<Charge> charges = chargesByTask(identifier(taskId), true);
        if (charges.isEmpty()) return;
        Charge charge = charges.get(0);
        if (charge.userId() != userId || !"reserved".equals(charge.status())) return;
        int deliveredForCharge = Math.max(0, Math.min(charge.expectedImages(), deliveredImages - charge.baselineImages()));
        int finalCost = proportional(charge.quotedPoints(), deliveredForCharge, charge.expectedImages());
        int refundPoints = Math.max(0, charge.reservedPoints() - finalCost);
        if (refundPoints > 0)
        {
            refund(userId, refundPoints);
            ledger(userId, refundPoints, "generation_refund",
                    "generation-refund:" + charge.chargeId() + ":" + charge.reservationRound(),
                    deliveredForCharge == 0 ? "任务未交付图片，积分已全额退回" : "未交付图片对应积分已退回", null);
        }
        jdbc.update("UPDATE bge_point_charge SET reserved_points = ?, charged_points = ?, delivered_images = ?, "
                        + "status = 'settled', settled_at = CURRENT_TIMESTAMP WHERE charge_id = ?",
                finalCost, finalCost, deliveredForCharge, charge.chargeId());
    }

    public AdminPage adminAccounts(String username, int pageNum, int pageSize)
    {
        String filter = safeText(username, 64);
        int page = Math.max(1, pageNum);
        int size = Math.max(1, Math.min(100, pageSize));
        int offset = (page - 1) * size;
        String like = "%" + filter + "%";
        Long total = jdbc.queryForObject("SELECT COUNT(*) FROM bge_point_account a JOIN sys_user u ON u.user_id = a.user_id "
                + "WHERE u.del_flag = '0' AND (? = '' OR u.user_name LIKE ? OR u.nick_name LIKE ?)", Long.class, filter, like, like);
        List<AdminAccount> rows = jdbc.query("SELECT a.user_id, u.user_name, u.nick_name, a.balance, a.lifetime_credited, "
                        + "a.lifetime_spent, a.updated_at FROM bge_point_account a JOIN sys_user u ON u.user_id = a.user_id "
                        + "WHERE u.del_flag = '0' AND (? = '' OR u.user_name LIKE ? OR u.nick_name LIKE ?) "
                        + "ORDER BY a.updated_at DESC, a.user_id DESC LIMIT ? OFFSET ?",
                (rs, row) -> new AdminAccount(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getLong(4),
                        rs.getLong(5), rs.getLong(6), rs.getTimestamp(7).toLocalDateTime().toString()),
                filter, like, like, size, offset);
        return new AdminPage(rows, total == null ? 0 : total.longValue());
    }

    @Transactional
    public Account adjust(long userId, long change, String note, String idempotencyKey, long operatorUserId)
    {
        if (change == 0 || Math.abs(change) > 1_000_000)
        {
            throw PortalException.badRequest("单次积分调整必须在 -1000000 到 1000000 之间且不能为 0。");
        }
        String reason = safeText(note, 200);
        if (reason.length() < 4)
        {
            throw PortalException.badRequest("积分调整必须填写不少于 4 个字符的原因。");
        }
        String reference = "admin-adjust:" + requestKey(idempotencyKey);
        List<long[]> existing = jdbc.query(
                "SELECT user_id, change_amount FROM bge_point_ledger WHERE reference_key = ? FOR UPDATE",
                (rs, row) -> new long[] { rs.getLong(1), rs.getLong(2) }, reference);
        if (!existing.isEmpty())
        {
            long[] recorded = existing.get(0);
            if (recorded[0] != userId || recorded[1] != change)
            {
                throw PortalException.conflict("该调账请求标识已用于其他调整。");
            }
            return account(userId);
        }
        ensureAccount(userId);
        if (change < 0)
        {
            debit(userId, Math.toIntExact(-change));
        }
        else
        {
            credit(userId, change);
        }
        ledger(userId, change, "admin_adjustment", reference, reason, operatorUserId);
        return lockedAccount(userId, false);
    }

    public List<Recharge> adminRecharges(String status)
    {
        String clean = safeText(status, 16);
        if (!clean.isEmpty() && !Set.of("pending", "approved", "rejected").contains(clean))
        {
            throw PortalException.badRequest("充值申请状态不合法。");
        }
        return jdbc.query("SELECT r.request_id, r.user_id, u.user_name, u.nick_name, r.points, r.status, r.user_note, "
                        + "r.review_note, r.requested_at, r.reviewed_at FROM bge_recharge_request r "
                        + "JOIN sys_user u ON u.user_id = r.user_id WHERE (? = '' OR r.status = ?) "
                        + "ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, "
                        + "r.request_id DESC LIMIT 500",
                (rs, row) -> new Recharge(rs.getLong(1), rs.getLong(2), rs.getString(3), rs.getString(4),
                        rs.getInt(5), rs.getString(6), rs.getString(7), rs.getString(8),
                        rs.getTimestamp(9).toLocalDateTime().toString(),
                        rs.getTimestamp(10) == null ? "" : rs.getTimestamp(10).toLocalDateTime().toString()), clean, clean);
    }

    @Transactional
    public Recharge reviewRecharge(long requestId, boolean approve, String note, long operatorUserId)
    {
        List<Recharge> rows = jdbc.query("SELECT r.request_id, r.user_id, u.user_name, u.nick_name, r.points, r.status, "
                        + "r.user_note, r.review_note, r.requested_at, r.reviewed_at FROM bge_recharge_request r "
                        + "JOIN sys_user u ON u.user_id = r.user_id WHERE r.request_id = ? FOR UPDATE",
                (rs, row) -> new Recharge(rs.getLong(1), rs.getLong(2), rs.getString(3), rs.getString(4),
                        rs.getInt(5), rs.getString(6), rs.getString(7), rs.getString(8),
                        rs.getTimestamp(9).toLocalDateTime().toString(),
                        rs.getTimestamp(10) == null ? "" : rs.getTimestamp(10).toLocalDateTime().toString()), requestId);
        if (rows.isEmpty()) throw PortalException.notFound();
        Recharge request = rows.get(0);
        if (!"pending".equals(request.status()))
        {
            throw PortalException.conflict("该充值申请已经处理，不能重复审核。");
        }
        String reviewNote = safeText(note, 200);
        if (!approve && reviewNote.length() < 4)
        {
            throw PortalException.badRequest("拒绝充值申请时必须填写不少于 4 个字符的原因。");
        }
        String next = approve ? "approved" : "rejected";
        jdbc.update("UPDATE bge_recharge_request SET status = ?, review_note = ?, reviewed_by = ?, "
                        + "reviewed_at = CURRENT_TIMESTAMP WHERE request_id = ? AND status = 'pending'",
                next, reviewNote, operatorUserId, requestId);
        if (approve)
        {
            ensureAccount(request.userId());
            credit(request.userId(), request.points());
            ledger(request.userId(), request.points(), "recharge", "recharge:" + requestId,
                    "充值申请审核通过", operatorUserId);
        }
        return recharge(requestId);
    }

    @Transactional
    public Price updatePrice(String profileId, String resolutionId, int points, String operatorName)
    {
        Profile profile = requireProfile(profileId);
        String resolution = requireResolution(resolutionId);
        if (points < 1 || points > 100_000)
        {
            throw PortalException.badRequest("套餐积分必须在 1 到 100000 之间。");
        }
        jdbc.update("UPDATE bge_point_price SET points = ?, updated_by = ? WHERE generation_profile_id = ? AND image_resolution_id = ?",
                points, safeText(operatorName, 64), profile.id(), resolution);
        return quote(profile.id(), resolution);
    }

    private void ensureAccount(long userId)
    {
        int inserted = jdbc.update("INSERT IGNORE INTO bge_point_account (user_id, balance, lifetime_credited) VALUES (?, ?, ?)",
                userId, WELCOME_POINTS, WELCOME_POINTS);
        if (inserted == 1)
        {
            jdbc.update("INSERT IGNORE INTO bge_point_ledger (user_id, change_amount, balance_after, event_type, reference_key, description) "
                    + "VALUES (?, ?, ?, 'welcome', ?, '新用户体验积分')", userId, WELCOME_POINTS, WELCOME_POINTS, "welcome:" + userId);
        }
    }

    private Account lockedAccount(long userId, boolean lock)
    {
        String suffix = lock ? " FOR UPDATE" : "";
        return jdbc.query("SELECT user_id, balance, lifetime_credited, lifetime_spent, updated_at FROM bge_point_account "
                        + "WHERE user_id = ?" + suffix,
                rs -> rs.next() ? new Account(rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getLong(4),
                        rs.getTimestamp(5).toLocalDateTime().toString()) : null, userId);
    }

    private long accountBalance(long userId)
    {
        Long balance = jdbc.queryForObject("SELECT balance FROM bge_point_account WHERE user_id = ?", Long.class, userId);
        return balance == null ? 0 : balance.longValue();
    }

    private void debit(long userId, int points)
    {
        int updated = jdbc.update("UPDATE bge_point_account SET balance = balance - ?, lifetime_spent = lifetime_spent + ? "
                + "WHERE user_id = ? AND balance >= ?", points, points, userId, points);
        if (updated != 1)
        {
            throw PortalException.paymentRequired("积分不足，本次需要 " + points + " 积分。请先充值或选择较小套图。");
        }
    }

    private void credit(long userId, long points)
    {
        jdbc.update("UPDATE bge_point_account SET balance = balance + ?, lifetime_credited = lifetime_credited + ? WHERE user_id = ?",
                points, points, userId);
    }

    private void refund(long userId, int points)
    {
        if (points <= 0) return;
        jdbc.update("UPDATE bge_point_account SET balance = balance + ?, lifetime_spent = GREATEST(0, lifetime_spent - ?) WHERE user_id = ?",
                points, points, userId);
    }

    private void ledger(long userId, long change, String type, String reference, String description, Long operator)
    {
        long balance = accountBalance(userId);
        jdbc.update("INSERT INTO bge_point_ledger (user_id, change_amount, balance_after, event_type, reference_key, description, operator_user_id) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?)",
                userId, change, balance, type, reference, safeText(description, 240), operator);
    }

    private long insertGenerated(String keyColumn, String sql, Object... parameters)
    {
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            PreparedStatement statement = connection.prepareStatement(sql, new String[] { keyColumn });
            for (int index = 0; index < parameters.length; index++)
            {
                statement.setObject(index + 1, parameters[index]);
            }
            return statement;
        }, keys);
        Number key = keys.getKey();
        if (key == null)
        {
            throw PortalException.conflict("积分记录创建失败，请稍后重试。");
        }
        return key.longValue();
    }

    private Price quote(String profileId, String resolutionId)
    {
        Profile profile = requireProfile(profileId);
        String resolution = requireResolution(resolutionId);
        List<Integer> points = jdbc.query("SELECT points FROM bge_point_price WHERE generation_profile_id = ? AND image_resolution_id = ?",
                (rs, row) -> rs.getInt(1), profile.id(), resolution);
        if (points.size() != 1)
        {
            throw PortalException.conflict("该套图价格暂不可用，请联系管理员。");
        }
        return price(profile.id(), resolution, points.get(0));
    }

    private Price price(String profileId, String resolutionId, int points)
    {
        Profile profile = requireProfile(profileId);
        String resolution = requireResolution(resolutionId);
        return new Price(profile.id(), profile.label(), profile.imageCount(), resolution,
                RESOLUTIONS.get(resolution), points);
    }

    private List<Charge> chargesByTask(String taskId, boolean lock)
    {
        return jdbc.query("SELECT charge_id, request_key, task_id, user_id, generation_profile_id, image_resolution_id, "
                        + "expected_images, baseline_images, quoted_points, reserved_points, charged_points, delivered_images, "
                        + "status, reservation_round FROM bge_point_charge WHERE task_id = ?" + (lock ? " FOR UPDATE" : ""),
                this::charge, taskId);
    }

    private Charge charge(java.sql.ResultSet rs, int row) throws java.sql.SQLException
    {
        return new Charge(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getLong(4), rs.getString(5),
                rs.getString(6), rs.getInt(7), rs.getInt(8), rs.getInt(9), rs.getInt(10), rs.getInt(11),
                rs.getInt(12), rs.getString(13), rs.getInt(14));
    }

    private Recharge recharge(long requestId)
    {
        return jdbc.query("SELECT r.request_id, r.user_id, u.user_name, u.nick_name, r.points, r.status, r.user_note, "
                        + "r.review_note, r.requested_at, r.reviewed_at FROM bge_recharge_request r "
                        + "JOIN sys_user u ON u.user_id = r.user_id WHERE r.request_id = ?",
                rs -> rs.next() ? new Recharge(rs.getLong(1), rs.getLong(2), rs.getString(3), rs.getString(4),
                        rs.getInt(5), rs.getString(6), rs.getString(7), rs.getString(8),
                        rs.getTimestamp(9).toLocalDateTime().toString(),
                        rs.getTimestamp(10) == null ? "" : rs.getTimestamp(10).toLocalDateTime().toString()) : null,
                requestId);
    }

    private Profile requireProfile(String value)
    {
        Profile profile = PROFILES.get(safeText(value, 40));
        if (profile == null) throw PortalException.badRequest("套图数量不在积分价格表中。");
        return profile;
    }

    private String requireResolution(String value)
    {
        String clean = safeText(value, 12).toLowerCase();
        if (!RESOLUTIONS.containsKey(clean)) throw PortalException.badRequest("清晰度不在积分价格表中。");
        return clean;
    }

    private String requestKey(String value)
    {
        String clean = safeText(value, 120);
        if (clean.length() < 8 || !clean.matches("[A-Za-z0-9._:-]+"))
        {
            throw PortalException.badRequest("作图请求缺少有效的防重复提交标识。");
        }
        return clean;
    }

    private String identifier(String value)
    {
        String clean = safeText(value, 120);
        if (clean.isEmpty() || !clean.matches("[A-Za-z0-9._:-]+")) throw PortalException.badRequest("任务编号不合法。");
        return clean;
    }

    private String safeText(String value, int maximum)
    {
        String clean = value == null ? "" : value.trim().replaceAll("[\\p{Cntrl}]", " ");
        return clean.length() <= maximum ? clean : clean.substring(0, maximum);
    }

    private int proportional(int points, int delivered, int expected)
    {
        if (delivered <= 0) return 0;
        return Math.min(points, (int) Math.ceil((double) points * delivered / Math.max(1, expected)));
    }

    private static Map<String, Profile> profiles()
    {
        Map<String, Profile> result = new LinkedHashMap<>();
        result.put("compact-1-2", new Profile("compact-1-2", "极速验证套图 1+2", 3));
        result.put("compact-2-3", new Profile("compact-2-3", "轻量套图 2+3", 5));
        result.put("compact-3-4", new Profile("compact-3-4", "核心卖点套图 3+4", 7));
        result.put("standard-5-8", new Profile("standard-5-8", "标准套图 5+8", 13));
        return Map.copyOf(result);
    }

    private record Profile(String id, String label, int imageCount) {}
    private record Charge(long chargeId, String requestKey, String taskId, long userId, String profileId,
            String resolutionId, int expectedImages, int baselineImages, int quotedPoints, int reservedPoints,
            int chargedPoints, int deliveredImages, String status, int reservationRound) {}

    public record Account(long userId, long balance, long lifetimeCredited, long lifetimeSpent, String updatedAt) {}
    public record Price(String generationProfileId, String profileLabel, int imageCount, String imageResolutionId,
            String resolutionLabel, int points) {}
    public record Ledger(long id, long change, long balanceAfter, String type, String description, String createdAt) {}
    public record Recharge(long id, long userId, String username, String nickName, int points, String status,
            String userNote, String reviewNote, String requestedAt, String reviewedAt) {}
    public record PortalPoints(Account account, List<Price> prices, List<Ledger> ledger,
            List<Recharge> recharges, List<Integer> rechargePackages) {}
    public record Reservation(long chargeId, String requestKey, int points, long balanceAfter) {}
    public record AdminAccount(long userId, String username, String nickName, long balance,
            long lifetimeCredited, long lifetimeSpent, String updatedAt) {}
    public record AdminPage(List<AdminAccount> rows, long total) {}
}
