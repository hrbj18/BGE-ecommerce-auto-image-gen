package com.ruoyi.bge.points;

import com.ruoyi.bge.support.PortalException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Read models, reconciliation and audited pricing for point operations. */
@Service
public class BgePointAdminService
{
    private static final Set<String> EVENT_TYPES = Set.of("welcome", "generation_reserve", "generation_retry",
            "generation_release", "generation_refund", "recharge", "admin_adjustment");
    private static final Set<String> CHARGE_STATUSES = Set.of("reserved", "released", "settled");
    private static final Set<String> RECHARGE_STATUSES = Set.of("pending", "approved", "rejected");
    private static final Map<String, Integer> PROFILE_IMAGES = Map.of(
            "compact-1-2", 3, "compact-2-3", 5, "compact-3-4", 7, "standard-5-8", 13);
    private static final Set<String> RESOLUTIONS = Set.of("1k", "2k", "4k");
    private static final DateTimeFormatter ADMIN_DATE = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final JdbcTemplate jdbc;
    private final BgePointService points;

    public BgePointAdminService(JdbcTemplate jdbc, BgePointService points)
    {
        this.jdbc = jdbc;
        this.points = points;
    }

    public Summary summary()
    {
        Aggregate aggregate = jdbc.query("SELECT COUNT(*), COALESCE(SUM(balance),0), "
                        + "COALESCE(SUM(lifetime_credited),0), COALESCE(SUM(lifetime_spent),0) FROM bge_point_account",
                rs -> rs.next() ? new Aggregate(rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getLong(4))
                        : new Aggregate(0, 0, 0, 0));
        long pendingCount = scalar("SELECT COUNT(*) FROM bge_recharge_request WHERE status = 'pending'");
        long pendingPoints = scalar("SELECT COALESCE(SUM(points),0) FROM bge_recharge_request WHERE status = 'pending'");
        long reservedCount = scalar("SELECT COUNT(*) FROM bge_point_charge WHERE status = 'reserved'");
        long reservedPoints = scalar("SELECT COALESCE(SUM(reserved_points),0) FROM bge_point_charge WHERE status = 'reserved'");
        long anomalyCount = reconciliation().size();
        return new Summary(aggregate.accounts(), aggregate.balance(), aggregate.credited(), aggregate.spent(),
                pendingCount, pendingPoints, reservedCount, reservedPoints, anomalyCount);
    }

    public LedgerPage ledgers(String username, String eventType, String from, String to, int pageNum, int pageSize)
    {
        String user = text(username, 64);
        String event = text(eventType, 32);
        if (!event.isEmpty() && !EVENT_TYPES.contains(event)) throw PortalException.badRequest("积分流水类型不合法。");
        Timestamp fromTime = timestamp(from, false);
        Timestamp toTime = timestamp(to, true);
        Page page = page(pageNum, pageSize);
        String like = "%" + user + "%";
        String where = " WHERE u.del_flag = '0' AND (? = '' OR u.user_name LIKE ? OR u.nick_name LIKE ?) "
                + "AND (? = '' OR l.event_type = ?) AND (? IS NULL OR l.created_at >= ?) AND (? IS NULL OR l.created_at <= ?) ";
        Object[] filters = { user, like, like, event, event, fromTime, fromTime, toTime, toTime };
        Long total = jdbc.queryForObject("SELECT COUNT(*) FROM bge_point_ledger l JOIN sys_user u ON u.user_id=l.user_id" + where,
                Long.class, filters);
        List<Object> args = new ArrayList<>(Arrays.asList(filters));
        args.add(page.size());
        args.add(page.offset());
        List<LedgerRow> rows = jdbc.query("SELECT l.ledger_id,l.user_id,u.user_name,u.nick_name,l.change_amount,"
                        + "l.balance_after,l.event_type,l.reference_key,l.description,COALESCE(op.user_name,''),l.created_at "
                        + "FROM bge_point_ledger l JOIN sys_user u ON u.user_id=l.user_id "
                        + "LEFT JOIN sys_user op ON op.user_id=l.operator_user_id" + where
                        + "ORDER BY l.ledger_id DESC LIMIT ? OFFSET ?",
                (rs, row) -> new LedgerRow(rs.getLong(1), rs.getLong(2), rs.getString(3), rs.getString(4),
                        rs.getLong(5), rs.getLong(6), rs.getString(7), rs.getString(8), rs.getString(9),
                        rs.getString(10), time(rs.getTimestamp(11))), args.toArray());
        return new LedgerPage(rows, total == null ? 0 : total);
    }

    public ChargePage charges(String username, String taskId, String status, int pageNum, int pageSize)
    {
        String user = text(username, 64);
        String task = text(taskId, 120);
        String cleanStatus = text(status, 20);
        if (!cleanStatus.isEmpty() && !CHARGE_STATUSES.contains(cleanStatus))
            throw PortalException.badRequest("任务结算状态不合法。");
        Page page = page(pageNum, pageSize);
        String like = "%" + user + "%";
        String taskLike = "%" + task + "%";
        String where = " WHERE u.del_flag='0' AND (?='' OR u.user_name LIKE ? OR u.nick_name LIKE ?) "
                + "AND (?='' OR c.task_id LIKE ?) AND (?='' OR c.status=?) ";
        Object[] filters = { user, like, like, task, taskLike, cleanStatus, cleanStatus };
        Long total = jdbc.queryForObject("SELECT COUNT(*) FROM bge_point_charge c JOIN sys_user u ON u.user_id=c.user_id" + where,
                Long.class, filters);
        List<Object> args = new ArrayList<>(Arrays.asList(filters));
        args.add(page.size());
        args.add(page.offset());
        List<ChargeRow> rows = jdbc.query("SELECT c.charge_id,c.user_id,u.user_name,u.nick_name,COALESCE(c.task_id,''),"
                        + "c.generation_profile_id,c.image_resolution_id,c.expected_images,c.quoted_points,c.reserved_points,"
                        + "c.charged_points,c.delivered_images,c.status,c.updated_at,c.settled_at FROM bge_point_charge c "
                        + "JOIN sys_user u ON u.user_id=c.user_id" + where + "ORDER BY c.charge_id DESC LIMIT ? OFFSET ?",
                (rs, row) -> new ChargeRow(rs.getLong(1), rs.getLong(2), rs.getString(3), rs.getString(4),
                        rs.getString(5), rs.getString(6), rs.getString(7), rs.getInt(8), rs.getInt(9),
                        rs.getInt(10), rs.getInt(11), rs.getInt(12), rs.getString(13), time(rs.getTimestamp(14)),
                        time(rs.getTimestamp(15))), args.toArray());
        return new ChargePage(rows, total == null ? 0 : total);
    }

    public RechargePage recharges(String status, int pageNum, int pageSize)
    {
        String clean = text(status, 16);
        if (!clean.isEmpty() && !RECHARGE_STATUSES.contains(clean))
            throw PortalException.badRequest("充值申请状态不合法。");
        Page page = page(pageNum, pageSize);
        Long total = jdbc.queryForObject("SELECT COUNT(*) FROM bge_recharge_request WHERE (?='' OR status=?)",
                Long.class, clean, clean);
        List<RechargeRow> rows = jdbc.query("SELECT r.request_id,r.user_id,u.user_name,u.nick_name,r.points,r.status,"
                        + "r.user_note,r.review_note,COALESCE(op.user_name,''),r.requested_at,r.reviewed_at "
                        + "FROM bge_recharge_request r JOIN sys_user u ON u.user_id=r.user_id "
                        + "LEFT JOIN sys_user op ON op.user_id=r.reviewed_by WHERE (?='' OR r.status=?) "
                        + "ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,"
                        + "r.request_id DESC LIMIT ? OFFSET ?",
                (rs, row) -> new RechargeRow(rs.getLong(1), rs.getLong(2), rs.getString(3), rs.getString(4),
                        rs.getInt(5), rs.getString(6), rs.getString(7), rs.getString(8), rs.getString(9),
                        time(rs.getTimestamp(10)), time(rs.getTimestamp(11))), clean, clean, page.size(), page.offset());
        return new RechargePage(rows, total == null ? 0 : total);
    }

    public List<Anomaly> reconciliation()
    {
        List<Anomaly> result = new ArrayList<>();
        result.addAll(jdbc.query("SELECT a.user_id,u.user_name,a.balance,l.balance_after,a.updated_at "
                        + "FROM bge_point_account a JOIN sys_user u ON u.user_id=a.user_id "
                        + "LEFT JOIN bge_point_ledger l ON l.ledger_id=(SELECT MAX(x.ledger_id) FROM bge_point_ledger x WHERE x.user_id=a.user_id) "
                        + "WHERE l.ledger_id IS NULL OR l.balance_after<>a.balance ORDER BY a.updated_at DESC LIMIT 100",
                (rs, row) -> new Anomaly("LEDGER_BALANCE_MISMATCH", "critical", rs.getLong(1), rs.getString(2),
                        "account:" + rs.getLong(1), "账户余额与最后一条积分流水不一致", time(rs.getTimestamp(5)))));
        result.addAll(jdbc.query("SELECT a.user_id,u.user_name,a.balance,a.updated_at "
                        + "FROM bge_point_account a JOIN sys_user u ON u.user_id=a.user_id "
                        + "WHERE a.balance<0 OR a.lifetime_credited<0 OR a.lifetime_spent<0 "
                        + "ORDER BY a.updated_at DESC LIMIT 100",
                (rs, row) -> new Anomaly("INVALID_ACCOUNT_BALANCE", "critical", rs.getLong(1), rs.getString(2),
                        "account:" + rs.getLong(1), "账户存在非法负值", time(rs.getTimestamp(4)))));
        Timestamp stale = Timestamp.valueOf(LocalDateTime.now().minusHours(3));
        result.addAll(jdbc.query("SELECT c.user_id,u.user_name,c.charge_id,COALESCE(c.task_id,''),c.updated_at "
                        + "FROM bge_point_charge c JOIN sys_user u ON u.user_id=c.user_id "
                        + "WHERE c.status='reserved' AND c.updated_at<? ORDER BY c.updated_at LIMIT 100",
                (rs, row) -> new Anomaly("STALE_RESERVATION", "warning", rs.getLong(1), rs.getString(2),
                        rs.getString(4).isEmpty() ? "charge:" + rs.getLong(3) : rs.getString(4),
                        "积分冻结超过 3 小时仍未结算", time(rs.getTimestamp(5))), stale));
        Timestamp overdueReview = Timestamp.valueOf(LocalDateTime.now().minusHours(24));
        result.addAll(jdbc.query("SELECT r.user_id,u.user_name,r.request_id,r.requested_at "
                        + "FROM bge_recharge_request r JOIN sys_user u ON u.user_id=r.user_id "
                        + "WHERE r.status='pending' AND r.requested_at<? ORDER BY r.requested_at LIMIT 100",
                (rs, row) -> new Anomaly("OVERDUE_RECHARGE_REVIEW", "warning", rs.getLong(1), rs.getString(2),
                        "recharge:" + rs.getLong(3), "充值申请超过 24 小时仍未审核", time(rs.getTimestamp(4))),
                overdueReview));
        result.addAll(jdbc.query("SELECT c.user_id,u.user_name,c.charge_id,COALESCE(c.task_id,''),c.updated_at "
                        + "FROM bge_point_charge c JOIN sys_user u ON u.user_id=c.user_id "
                        + "WHERE c.status NOT IN ('reserved','released','settled') OR c.expected_images<=0 "
                        + "OR c.delivered_images<0 OR c.delivered_images>c.expected_images "
                        + "OR c.quoted_points<0 OR c.reserved_points<0 OR c.charged_points<0 "
                        + "ORDER BY c.updated_at DESC LIMIT 100",
                (rs, row) -> new Anomaly("INVALID_CHARGE_STATE", "critical", rs.getLong(1), rs.getString(2),
                        rs.getString(4).isEmpty() ? "charge:" + rs.getLong(3) : rs.getString(4),
                        "任务积分结算数据不合法", time(rs.getTimestamp(5)))));
        result.sort(Comparator.comparing(Anomaly::detectedAt).reversed());
        return result.stream().limit(200).toList();
    }

    @Transactional
    public List<BgePointService.Price> updatePrices(String idempotencyKey, String reason, String operator,
            List<PriceInput> inputs)
    {
        String request = identifier(idempotencyKey, 120, "改价请求缺少有效的幂等标识。");
        String cleanReason = text(reason, 200);
        if (cleanReason.length() < 4) throw PortalException.badRequest("修改套餐价格必须填写不少于 4 个字符的原因。");
        Map<String, Integer> submitted = normalizePrices(inputs);
        String fingerprint = fingerprint(submitted);
        List<String> existing = jdbc.query("SELECT DISTINCT payload_fingerprint FROM bge_point_price_history WHERE request_key=?",
                (rs, row) -> rs.getString(1), request);
        if (!existing.isEmpty())
        {
            if (existing.size() != 1 || !existing.get(0).equals(fingerprint))
                throw PortalException.conflict("该改价请求标识已用于其他价格内容。");
            return points.prices();
        }

        Map<String, Integer> current = new HashMap<>();
        jdbc.query("SELECT generation_profile_id,image_resolution_id,points FROM bge_point_price FOR UPDATE",
                rs -> { current.put(key(rs.getString(1), rs.getString(2)), rs.getInt(3)); });
        if (!current.keySet().equals(submitted.keySet())) throw PortalException.conflict("套餐价格表不完整，暂不能保存。");
        String user = text(operator, 64);
        for (Map.Entry<String, Integer> entry : submitted.entrySet())
        {
            String[] parts = entry.getKey().split("/", 2);
            int oldPoints = current.get(entry.getKey());
            jdbc.update("INSERT INTO bge_point_price_history (request_key,payload_fingerprint,generation_profile_id,"
                            + "image_resolution_id,old_points,new_points,change_reason,updated_by) VALUES (?,?,?,?,?,?,?,?)",
                    request, fingerprint, parts[0], parts[1], oldPoints, entry.getValue(), cleanReason, user);
            jdbc.update("UPDATE bge_point_price SET points=?,updated_by=? WHERE generation_profile_id=? AND image_resolution_id=?",
                    entry.getValue(), user, parts[0], parts[1]);
        }
        return points.prices();
    }

    public List<PriceHistory> priceHistory()
    {
        return jdbc.query("SELECT history_id,request_key,generation_profile_id,image_resolution_id,old_points,new_points,"
                        + "change_reason,updated_by,created_at FROM bge_point_price_history ORDER BY history_id DESC LIMIT 100",
                (rs, row) -> new PriceHistory(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4),
                        rs.getInt(5), rs.getInt(6), rs.getString(7), rs.getString(8), time(rs.getTimestamp(9))));
    }

    private Map<String, Integer> normalizePrices(List<PriceInput> inputs)
    {
        if (inputs == null || inputs.size() != PROFILE_IMAGES.size() * RESOLUTIONS.size())
            throw PortalException.badRequest("必须一次提交完整的 12 项套餐价格。");
        Map<String, Integer> result = new LinkedHashMap<>();
        for (PriceInput input : inputs)
        {
            String profile = text(input.profileId(), 40);
            String resolution = text(input.resolutionId(), 12).toLowerCase();
            if (!PROFILE_IMAGES.containsKey(profile) || !RESOLUTIONS.contains(resolution))
                throw PortalException.badRequest("套餐或清晰度不在价格表中。");
            if (input.points() < 1 || input.points() > 100_000)
                throw PortalException.badRequest("套餐积分必须在 1 到 100000 之间。");
            if (result.put(key(profile, resolution), input.points()) != null)
                throw PortalException.badRequest("套餐价格存在重复项。");
        }
        Set<String> expected = new HashSet<>();
        PROFILE_IMAGES.keySet().forEach(profile -> RESOLUTIONS.forEach(resolution -> expected.add(key(profile, resolution))));
        if (!result.keySet().equals(expected)) throw PortalException.badRequest("套餐价格组合不完整。");
        return result;
    }

    private String fingerprint(Map<String, Integer> prices)
    {
        try
        {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            String canonical = prices.entrySet().stream().sorted(Map.Entry.comparingByKey())
                    .map(entry -> entry.getKey() + "=" + entry.getValue()).reduce((a, b) -> a + ";" + b).orElse("");
            return HexFormat.of().formatHex(digest.digest(canonical.getBytes(StandardCharsets.UTF_8)));
        }
        catch (Exception exception)
        {
            throw new IllegalStateException("无法计算价格变更指纹。", exception);
        }
    }

    private Timestamp timestamp(String value, boolean endOfDay)
    {
        String clean = text(value, 19);
        if (clean.isEmpty()) return null;
        try
        {
            LocalDateTime parsed = clean.length() == 10
                    ? java.time.LocalDate.parse(clean).atTime(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0)
                    : LocalDateTime.parse(clean, ADMIN_DATE);
            return Timestamp.valueOf(parsed);
        }
        catch (DateTimeParseException exception)
        {
            throw PortalException.badRequest("时间筛选格式不合法。");
        }
    }

    private Page page(int number, int size)
    {
        int cleanNumber = Math.max(1, number);
        int cleanSize = Math.max(1, Math.min(100, size));
        return new Page(cleanSize, (cleanNumber - 1) * cleanSize);
    }

    private long scalar(String sql)
    {
        Long value = jdbc.queryForObject(sql, Long.class);
        return value == null ? 0 : value;
    }

    private String text(String value, int maximum)
    {
        String clean = value == null ? "" : value.trim().replaceAll("[\\p{Cntrl}]", " ");
        return clean.length() <= maximum ? clean : clean.substring(0, maximum);
    }

    private String identifier(String value, int maximum, String message)
    {
        String clean = text(value, maximum);
        if (clean.length() < 8 || !clean.matches("[A-Za-z0-9._:-]+")) throw PortalException.badRequest(message);
        return clean;
    }

    private String key(String profile, String resolution) { return profile + "/" + resolution; }
    private String time(Timestamp value) { return value == null ? "" : value.toLocalDateTime().toString(); }

    private record Aggregate(long accounts, long balance, long credited, long spent) {}
    private record Page(int size, int offset) {}
    public record Summary(long accountCount, long totalBalance, long lifetimeCredited, long lifetimeSpent,
            long pendingRechargeCount, long pendingRechargePoints, long reservedChargeCount,
            long reservedPoints, long anomalyCount) {}
    public record LedgerRow(long id, long userId, String username, String nickName, long change,
            long balanceAfter, String eventType, String referenceKey, String description,
            String operatorName, String createdAt) {}
    public record LedgerPage(List<LedgerRow> rows, long total) {}
    public record ChargeRow(long id, long userId, String username, String nickName, String taskId,
            String profileId, String resolutionId, int expectedImages, int quotedPoints, int reservedPoints,
            int chargedPoints, int deliveredImages, String status, String updatedAt, String settledAt) {}
    public record ChargePage(List<ChargeRow> rows, long total) {}
    public record RechargeRow(long id, long userId, String username, String nickName, int points,
            String status, String userNote, String reviewNote, String reviewerName,
            String requestedAt, String reviewedAt) {}
    public record RechargePage(List<RechargeRow> rows, long total) {}
    public record Anomaly(String code, String severity, long userId, String username,
            String reference, String description, String detectedAt) {}
    public record PriceInput(String profileId, String resolutionId, int points) {}
    public record PriceHistory(long id, String requestKey, String profileId, String resolutionId,
            int oldPoints, int newPoints, String reason, String operatorName, String createdAt) {}
}
