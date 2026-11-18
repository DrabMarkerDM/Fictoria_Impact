/** dm34 交互层配置（迁移说明见 docs/dm34 交互 JS 化方案.md） */

export const CONFIG = {
    /** allowUntamed：读不出主人 id 时放行，避免整条链路因读不到而失效 */
    owner: {
        allowUntamed: true,
    },

    /** 背包已交回原版（interact 条目全不命中时引擎自动弹物品栏），空对象仅为兼容老配置 */
    bag: {
        /** 老开关，已失效 */
        retired: true,
    },

    /** 盔甲：手持盔甲右键装到她对应槽位，旧件塞回玩家背包（塞不下才掉地上）。仅 player:dm34 */
    armor: {
        enabled: true,
        /** 潜行在武装态是"解除状态"，此时不抢 */
        unlessSneaking: true,
    },

    /** 耕地：手持任意锄头右键进入耕地态。真件序列化存 dm34:hoe，退出时还回玩家背包 */
    farm: {
        enabled: true,
        /** 潜行在非闲置态是"解除状态"，此时不抢 */
        unlessSneaking: true,
        /** 主手替身巡检：farm 组自带 minecraft:equipment（铁锄），组结算/重进世界会把主手刷回铁锄，
         *  交互瞬间那几次重摆覆盖不到这些时机。关掉则重进世界后又见铁锄 */
        repaintGuard: true,
    },

    /** 武器：手持剑/弓/弩右键进入对应形态。真武器收进她的容器，主手放同属性 clone 当外观 */
    weapon: {
        enabled: true,
        /** 存放真武器的动态属性（值是容器槽号，-1 = 没存） */
        slotProp: 'dm34:wslot',
        /** 真武器从第几格开始存。horse 型容器 0/1 是马鞍/马铠伪槽，不能占用 */
        storeFrom: 2,
    },

    /** 盾牌：右键装盾、潜行+Maid_Command 卸盾、战斗姿态自动举盾。
     *  可挡伤害白名单见 common/shield_block.js 的 DEFAULT_HIT_CAUSES。不扣耐久（盾是真件） */
    shield: {
        enabled: true,
        /** 盾挂副手，由 dm34.json 的 interact 条目 equip_item_slot 交给引擎搬真件。
         *  🔴 on_ta.equippable.slots 只留整数鞍槽 0：整数槽与字符串槽混排会让整个 slots 数组被 schema 丢弃 */
        /** 举盾的本能反应半径（格）。已锁定目标与挨过打的威胁另有判据，不受此限。
         *  🔴 不能填 0：0 = 全维度扫描，会让她没敌人也一直举盾慢走 */
        range: 6,
        /** 贴脸探测节流：每几轮巡检探一次（5 tick/轮，4 轮 = 1 秒）。1 = 不节流 */
        probeRounds: 4,
        /** 已锁定目标算"在交战"的最大距离（格）。16 = 骷髅/掠夺者射程 */
        lockRange: 16,
        /** 举盾巡检间隔（tick），与女仆名单重建同频 */
        pollTicks: 5,
        /** 正面锥形：水平/垂直半角（度）。
         *  垂直默认关闭（90 = 只判水平）：判定点在脚底，比她高 2~3 格的目标会被误判成不在正面 */
        yawDeg: 70,
        pitchDeg: 90,
        /** 从首次挡下起连续举盾上限（tick），期间再挨打不续命。闲置形态不持盾 */
        holdTicks: 50,
        /** 放下盾后的冷却（tick），之后敌人仍在范围内就重新抬 */
        cooldownTicks: 50,
        /** 举盾时移动速度系数 */
        slowFactor: 0.6,
        /** 挡下时推开攻击者的力度 */
        knockbackHorizontal: 1.2,
        knockbackVertical: 0.45,
        /** 挡下箭矢是否也推射手（原版不推） */
        knockbackProjectiles: false,
        /** 挡下箭矢是否反弹（反折 + 减速 + 略上挑，可反伤射手） */
        deflectProjectiles: true,
        /** 无方向、无攻击者的持续伤害：举盾即静默挡掉，不计数不响音效 */
        ambientCauses: ["wither", "magic"],
    },

    /** 装备槽守卫：她自己捡来的东西不许占主手 / 盔甲槽 */
    guard: {
        enabled: true,
        /** 巡检间隔（tick） */
        intervalTicks: 20,
    },

    /** 采集：手持镐/斧右键进入挖矿 / 砍树。
     *  不占 variant —— 靠附加组件组 dm_mine / dm_chop 走原生 move_to_block，JS 只负责"到了就敲"，
     *  好处是不用重编 interact_tables。镐/斧与锄头同构：真件存记录、主手摆替身、退出时掉落归还 */
    gather: {
        enabled: true,
        /** 巡检间隔（tick） */
        intervalTicks: 10,
        /** 敲击半径（格），切比雪夫距离。取 3 以容忍"树干底部在斜上方 / 隔着一格树叶" */
        reach: 3,
        /** 到位自救：引擎常在 within_radius(2.5) 处撒手，而 reach 判的是方块中心，差 1~2 格就够不到。
         *  连续 forceReachAfter 轮「没在动 + 目标不在 reach」→ 放宽 forceReachExtra 格就地开敲 */
        forceReachAfter: 4,
        forceReachExtra: 1.5,
        /** 小扫描半径（格）：实时精确匹配，扫到就在该方块摆一个裂痕空壳当假实体目标，走位交给引擎。
         *  同时回写中景地图（新出现的方块补进去）。
         *  🔴 不能超过 midReach，否则摆得出裂痕但引擎锁不上 */
        scanReach: 24,
        /** 小扫描每几轮巡检真扫一次（走批量原生扫，成本很低） */
        scanEvery: 2,

        // ── 中景快照：世界坐标对齐的 16³ 子区块地图 ─────────────────────────
        //  以 16³ 子区块为单位、按 Math.floor(cx/16) 对齐（不是以她为心切块），
        //  对齐后才能跨位置复用：她往前走只扫新进窗口的子区块，身后的直接命中缓存。
        //  用 system.runJob 生成器一帧扫一个子区块，由近到远排队，懒读取（扫完一块就能用）。
        //  三层分工：中景(midReach 48) 选目标 → 小扫描(24) 精确匹配 + 补水 → move_to_block(64) 纯寻路。
        //  🔴 midReach 必须等于 JSON dm_walk_mine/dm_walk_chop 的
        //     nearest_attackable_target.within_radius 与 entity_types[].max_dist，
        //     否则裂痕摆得出来但引擎锁不上（verify_interact.py 会判 FAIL）。scanReach ≤ midReach 即可。
        midReach: 48,
        /** 中景快照总开关。关掉退回"小扫描 24 + move_to_block 64" */
        snapshotEnabled: true,
        /** 子区块边长（格）。🔴 固定 16：对齐规则一变缓存全部作废 */
        midChunk: 16,
        /** 子区块向下/向上看几格（相对建图时她脚下的 y）。
         *  🔴 midUp 同时是选点窗上界（midPick 的 upLim），不是扫描余量：
         *  它太小会导致高处树干/矿物根本不进图，与 maxPillar(12) 配套 */
        midDown: 8,
        midUp: 12,
        /** 快照最多存几块命中，防极端地形撑爆内存 */
        midMaxCells: 4000,
        /** 每轮最多验几块候选（验是否还在 / 是否自然树），结果写进 cell.ok 永久缓存 */
        midProbe: 24,
        /** 缓存窗口外扩（格）：子区块中心超出 midReach + midKeepPad 就淘汰。
         *  走路时不重建整张图，只丢身后的、补新进窗口的 */
        midKeepPad: 16,
        /** 全量重扫间隔（tick）：只把 scanned 标记打回未扫，cells 不动。
         *  防止"扫过就永不重扫"留下的盲区（她挖开岩壁后露出的矿） */
        snapRefreshTicks: 200,

        /** 远景引导（dm_guide_* 的 move_to_block）：定位是纯寻路接近，只在没有任何可锁目标时出场。
         *  🔴 priority=7 必须大于 move_towards_target 的 6（数字小的先跑），否则两股劲对拉 = 原地抖。
         *  🔴 判据是"扫描圈里有没有木头候选"而不是"有没有合法目标"：圈里有候选但全是玩家建筑也摘掉，
         *     让她自己溜达；圈里一片没有才挂上。走出扫描圈后候选归零，引导自动挂回 */
        guideQuietRounds: 3,
        /** 引擎锁不上的兜底：JS 有目标、裂痕在场、entity.target 却连续这么多轮为空 →
         *  重新挂 dm_guide_* 当"走过去"用。JSON 侧已补 follow_range:100 从根上解决 */
        guideFallbackRounds: 6,
        /** 判自然树时最多试几个候选（按距离由近到远） */
        naturalProbe: 8,
        /** 走位标记用的裂纹时长（tick，property 上限 1200）。
         *  🔴 到位后只 setProperty 改时长，不拆掉重摆：拆摆会让引擎反复 lose/acquire → 原地抖 + 语音连播 */
        markTicks: 1200,
        /** 连续几轮扫不到目标才拆裂痕壳。单轮空就拆会造成 0.5 秒一循环的 acquire/lose */
        crackGraceRounds: 2,

        // ── 试走验证（默认关闭，实测失败：walk 导航到不了嵌在岩层里的矿，每块卡 6 秒必然超时）──
        probeVerify: false,
        /** 超过这个水平距离才试走 */
        probeMinDist: 12,
        /** 试走超时（巡检轮数） */
        probeTimeoutRounds: 12,
        /** 试走失败后同一格在这么多轮内不再试走，否则永远在最近那块上打转 */
        probeTriedRounds: 200,
        /** on_reach 触发时，身边这么多格内的矿记成可达（goal_radius 也是 2） */
        probeRadius: 2,
        /** 同一块方块裂痕重建的退避起点 / 上限（tick）：20 → 40 → 80 → 之后固定上限。
         *  换目标 / 换时长不受限（正常的拆旧摆新必须立刻生效） */
        crackRetryTicks: 20,
        crackRetryMax: 100,
        /** 临时诊断：把走位链路四段状态报到聊天栏（总条数由 gather.js 的 diagBudget 卡住） */
        diag: false,
        diagEvery: 60,
        /** 一块要敲多久（tick），HARDNESS 查不到时用它 */
        defaultTicks: 10,
        /** 原木基准 tick（铁斧、硬度 2.0）；树种太多不逐条列 */
        logTicks: 10,
        /** 树叶 tick：留 4 让挥手不空转 */
        leafTicks: 4,
        /** 挖掘节奏系数。🔴 1 = 原版速度（时长按硬度×5 算，材质由 ticksWithTool 折算） */
        digPace: 1,
        /** 单块时长上限（tick），远古残骸铁级 150 */
        digMaxTicks: 200,
        /** 已废弃：现在每轮巡检都挥手+响+飞碎屑。留着只为老存档配置合并不报缺字段 */
        soundEveryRounds: 1,
        /** 砍树连带上限（格）。2×2 大型橡木主干净高 16~20 格，加分枝可到 90+ */
        maxChain: 96,
        /** 树冠包围盒半径 / 上方高度（格）：零碎枝干不接地也不在 6 向邻接里，靠"在树冠范围内"认同株 */
        canopyRadius: 8,
        canopyUp: 8,
        /** 伐木任务记忆有效期（巡检轮数）：期间该包围盒内的同种原木不再过自然树判定，
         *  否则木桩 / 悬空残段追不到树叶，索敌永远扫不上 */
        chopTaskRounds: 1200,
        /** 任务表里的块攒够这么多轮还没接近就剔除，否则够不到的残骸会一直霸占"任务表优先" */
        chopTaskDropRounds: 8,
        /** 自然树判定全局缓存有效期（巡检轮数），多只女仆同林共享。
         *  方块被挖掉时 bustTrunkMemo 会立刻作废 */
        trunkMemoTtl: 240,
        /** 该缓存容量上限（列数），超了丢最早的 */
        trunkMemoMax: 4096,
        /** 采矿连带上限（格）：矿脉是 3D 团块，留余量给"两个矿脉贴在一起" */
        chainOre: 24,
        /** 已废弃：连锁改成一键同 tick 全清。留着只为老存档配置合并 */
        chainPerRound: 2,
        /** 一键连锁最多生成几个飞行掉落物实体，其余直接入包。
         *  🔴 每个飞行掉落物占一条 system.runInterval，而它全局有数量上限；
         *  一棵大树刷 20 个会把额度吃满，紧接着的 startPillar 就挂不上调度（垫柱状态机不跑） */
        maxDropEntities: 8,
        /** 自救挖掘时每批允许生成几个"飞向她"的掉落物（同上，防吃满 runInterval 额度） */
        dropVisualPerBatch: 4,

        // ── 自然物判定（防把玩家搭的原木建筑当树连锁拆掉） ──
        /** 连锁采集总开关。关掉退回"只砍当前这一块" */
        chainEnabled: true,
        /** 只砍自然树：判据见 gather.js 的 analyzeColumn（竖轴 + 扎根 + 截面 ≤4 + 上方有自然树冠） */
        naturalOnly: true,
        /** 开树门：附近有自然树但一片原木都够不到时，先挖掉最近的天然树叶开路（不碰玩家装饰叶） */
        clearLeaves: true,
        /** 拆门叶的搜索半径（水平格），只在"有原木候选但一块都不算自然树"时用。
         *  🔴 不能跟着 scanReach 走：blockingLeaf 是逐格 getBlock，24 格要 14406 次跨界调用 */
        leafDoorRadius: 4,
        /** 赶路清路（JS 兜底）。挡路叶子已交给 JSON 的 minecraft:break_blocks（11 种树叶）；
         *  只有实测发现原生不触发时才打开这段 */
        clearPathLeaves: false,
        /** 判定"被树叶卡住"的时长（tick）：3 秒没挪窝，正常赶路不会误触发 */
        stuckPathTicks: 60,
        /** 清路扫描半径（水平格） */
        clearPathRadius: 3,
        /** 一次最多清几片叶子（按方块数算，每片顺带开它头顶那格） */
        clearPathMax: 3,
        /** 把连锁 / 不连锁的判定原因报到聊天框（只报前 12 条） */
        reportChain: false,
        /** 树冠抽样半径：从树干顶端水平往外找树叶 */
        canopyR: 4,
        /** 树冠抽样向上看几层 */
        canopyLayers: 4,
        /** 树冠至少几片树叶才算一棵树（容忍被薅掉一部分） */
        canopyMin: 8,
        /** 从候选原木向上追树冠的最大高度（ jungle 巨树约 30 格） */
        canopyUp: 40,
        /** 向下判"扎根"时允许穿过的空气格数。
         *  她自己从下往上砍，砍掉底部后剩下那截必然悬空 —— 不允许穿空隙就会中途判成"不是树"，
         *  连锁中断、也不垫柱。放宽的只是断口：一路空气到底碰到土的照样被"上方要有自然叶"挡掉。
         *  12 = maxPillar（更高的悬空段本来也够不到） */
        trunkGap: 12,
        /** 任务存档用的动态属性键：'mine' / 'chop' */
        jobProp: 'dm34:gjob',

        // ── 垫柱升空（够不到高处的矿 / 木头时自己搭上去） ──
        /** reach 内没目标时的补扫半径（水平格） */
        farReach: 3,
        /** 补扫的上方高度：脚上 2..farUp 格 */
        farUp: 9,
        /** 补扫每几轮巡检真扫一次 */
        farEvery: 2,
        /** 判定"走不过去了"：连续几次补扫位置累计位移 < 0.4 格 */
        stuckRounds: 3,
        /** 垫柱上限（格）：防一路垫到天上，也防包里方块被吃空 */
        maxPillar: 12,
        /** 垫柱看门狗（tick）：状态机卡住时 tickOne 会每轮 return 且不自愈，超时强制收尾 */
        pillarWatchdogTicks: 400,
        /** 垫柱硬上限（tick）：由 tickAll 直接检查，不依赖 runInterval 是否挂上 */
        pillarHardCapTicks: 600,
        /** 拉黑表容量上限。超量丢最早的，否则周围会被全拉黑 → 无目标 → 漫游 */
        giveUpMax: 48,
        /** 柱子清理的兜底等待（巡检轮数）：她一直有目标也最多等这么久就开始拆 */
        trailIdleFallbackRounds: 4,
        /** 拆柱时一轮清几格（拆的都是她不在的那一列） */
        trailCollapseBurst: 3,
        /** 垫柱起跳冲量（原版玩家约 0.42） */
        pillarJump: 0.55,
        /** 只在这个水平距离内才垫柱。取 2.8：move_towards_target 的 within_radius 是 2.5，
         *  阈值太小会让她停在 2.4~2.6 格时既不垫也不敲；2.8 < reach 3，垫上去仍够得着 */
        pillarSpread: 2.8,
        /** 垫柱成功后的保护窗（巡检轮数）：窗内不拆柱、不挂走位，直接敲那块目标，
         *  否则 scanTarget 一时返回空就会数到 Idle 拆柱、她踩空掉回地面 */
        pillarGraceRounds: 10,
        /** 同一块目标最多垫几次柱：垫上去还敲不到说明问题不在高度，拉黑换块 */
        pillarTries: 3,
        /** 站着不动这么多轮就放弃当前目标。目标粘性会让够不到的那块一直霸占选点，
         *  旁边贴脸的方块永远轮不到 */
        giveUpRounds: 12,
        /** 走不动判据：连续这么多轮离目标的水平距离没缩短 approachGain 格就开挖。
         *  🔴 不能用相邻两轮位移判：顶墙时引擎一直在推，她会左右滑 0.3~0.5 格，永远判"在走路" */
        approachRounds: 8,
        /** 贴墙即挖：目标在此距离内、同一层、连线中间横着实心方块就不等计时立刻开挖 */
        wallDigDist: 5,
        /** 认作"真的近了"的最小幅度（格），小于它只当抖动不重置计时 */
        approachGain: 1.0,
        /** 逐格自救往下铺几格，要盖住"墙后 5 格"这种厚度 */
        digReach: 6,
        /** 状态快照间隔（巡检轮数）。0 = 关；日志一行可区分"没选到 / 走不到 / 挖不动" */
        traceEvery: 40,
        /** 拉黑多久（巡检轮数），到点自动解禁 */
        giveUpCooldown: 120,

        // ── 采集牵绳（采集态不跟随，防她一路追出 48 格） ──
        /** 离主人超过这么多格就传送回身边。0 = 关闭。
         *  超距时：撤锚点 + 拉黑当前目标 + 收柱子 + 传送。用传送而非走回来是因为她可能在绕树/垫柱/掉坑，
         *  自己走回来会二次走丢 */
        leashRadius: 32,
        /** 两次牵绳传送的最小间隔（巡检轮数），防"传回来立刻又选中远处同一块" */
        leashCooldown: 40,
        /** 拆柱前要闲够几轮：刚垫上去那两格还在找落点，一拆就掉回地面 */
        descendIdleRounds: 4,

        // ── 挖穿挡路的岩层（矿物在墙后 / 山坡里） ──
        /** 走廊最长几格，超过说明该绕路而不是该挖过去 */
        tunnelMaxLen: 14,
        /** 一条走廊最多拆几格（含头上一格） */
        tunnelMaxCells: 64,
        /** 同一块目标最多试几次挖穿 */
        tunnelTries: 2,
        /** 两次挖穿之间至少隔几轮（挖完得给她时间走过去） */
        tunnelCooldownRounds: 24,

        // ── 卡住自救：挖到够得着 ──
        /** 两次自救拆除之间至少隔几轮，让她先走进新洞口，别原地把山挖穿人却没挪 */
        digStepRounds: 1,
        /** 一次最多拆几格同类型相邻方块。她占 2 格高，4 格 = 一次推进一整格隧道 */
        digBurst: 4,
        /** 一轮巡检里连挖几批，中途够到 / 前面空了 / 到上限就收手 */
        digChain: 3,
        /** 同一块目标最多拆几格。到量还没够到说明不是墙体问题，拉黑换块 */
        digMaxBlocks: 80,

        // ── 悬崖搭桥（矿在悬崖对面时用泥土搭路过去） ──
        //  digStepToward 的入口判据是"前面有没有可拆的方块"，悬崖对岸前方全是空气 → 直接返回 false。
        /** 总开关。关掉退回"只挖不搭" */
        bridgeEnabled: true,
        /** 同层判据（格）：垂直差在此范围内才搭桥。更大的高度差交给垫柱 / 往下挖 */
        bridgeDy: 1.5,
        /** 一次任务最多搭几格，到量还够不到说明崖太宽或方向算错 */
        bridgeMax: 24,
        /** 两次搭桥之间的最小间隔（巡检轮数）。真正的节奏闸是"她必须站到上一格上" */
        bridgeStepRounds: 1,
        /** 搭好一格后最多等她几轮走上去，超时 = 没跟上来 → 停搭桥交回原链路 */
        bridgeWaitRounds: 8,
    },

    /** 烹饪 */
    cook: {
        /** 一锅多久（tick），原生 cook_Na 的 timer 是 3 秒 */
        ticks: 60,
        /** 出锅后熟食挂手上展示多久，随后入包并开下一锅 */
        storeDelayTicks: 40,
        /** 自动烹饪：闲置空手时吃背包里的生食，做完塞回背包，背包满则掉地上 */
        auto: true,
        /** 没食材时保持展示熟食：不回闲置，让 cook_Nb 组继续挂着（movement 仍为 1e-19）。
         *  退出只有两条：潜行右键取消，或往她包里放生食 */
        holdDone: true,
        /** 自动烹饪巡检间隔（tick） */
        autoIntervalTicks: 40,
        /** 烹饪语音冷却（tick）。语音改由 cook.js 播，自动连锅时一个冷却内最多一声；
         *  玩家亲手喂的那锅不受限 */
        voiceCoolTicks: 300,
        /** 烹饪语音音量（dimension.playSound 的 volume 乘数） */
        voiceVolume: 1.0,
        /** 烹饪状态存档用的动态属性键。值 = n*2（生）/ n*2+1（熟），0 = 没在做饭 */
        prop: 'dm34:cook',
        /** 谁在做饭：0 没人 / 1 玩家手动 / 2 自动（收尾时决定下一轮） */
        autoProp: 'dm34:auto',
    },

    /** 日志总闸：默认全关，排查时逐档打开。模块加载期读取，改完必须重进世界。
     *  console   内容日志（诊断、换甲回收、残留清理、丢失件记录）
     *  chat      聊天栏开发提示（启动横幅、交互链路诊断配额）
     *  debug     交互链路逐环诊断，每按一次右键都打
     *  diagQuota debug 打开时允许打到聊天栏的前 N 条（0 = 只进内容日志）
     *  玩家操作反馈（"取下 N 件盔甲"）不归这里管：它们在失败时才出现，关掉等于藏原因 */
    log: {
        console: true,
        chat: false,
        debug: false,
        diagQuota: 0,
        /** 耕地态交互取证：只在 st=farm 时打，一次右键一行，限 40 条 */
        farmTrace: true,
        /** 卸甲残留告警：只进控制台，且不受 log.console 总闸管辖（异常告警不该还要先翻开关） */
        armorGhost: true,
    },
};

/** 会进入烹饪态的事件（cook_1a ~ cook_10a） */
export const COOK_START_RE = /^cook_(\d+)a$/;

/** 原版剑 → 武器族 */
export const SWORDS = [
    "minecraft:wooden_sword", "minecraft:stone_sword", "minecraft:iron_sword",
    "minecraft:golden_sword", "minecraft:diamond_sword", "minecraft:netherite_sword",
    "minecraft:copper_sword",
];

/** 原版物品标签：任意剑（1.26 起 ItemStack.getTags() 可读） */
export const SWORD_TAG = "minecraft:is_sword";

/** 原版长矛全材质（7 种）。不做投掷：只按近战戳刺处理，
 *  与剑同一套 melee_box_attack，区别全在资源包动画 */
export const SPEARS = [
    "minecraft:wooden_spear", "minecraft:stone_spear", "minecraft:iron_spear",
    "minecraft:golden_spear", "minecraft:diamond_spear", "minecraft:netherite_spear",
    "minecraft:copper_spear",
];

/** 原版物品标签：任意长矛 */
export const SPEAR_TAG = "minecraft:is_spear";

/** 原版锄头全材质（原生表只有 iron_hoe），末尾用 is_hoe 标签兜底模组锄 */
export const HOES = [
    "minecraft:wooden_hoe", "minecraft:stone_hoe", "minecraft:iron_hoe",
    "minecraft:golden_hoe", "minecraft:diamond_hoe", "minecraft:netherite_hoe",
    "minecraft:copper_hoe",
];

/** 原版物品标签：任意锄头 */
export const HOE_TAG = "minecraft:is_hoe";

/** 手持物 → 耕地形态键；不是锄头返回 undefined
 *  @param {string[]} [tags] 有 minecraft:is_hoe 即按锄头处理 */
export function hoeFamilyOf(itemId, tags) {
    if (!itemId) return undefined;
    if (HOES.includes(itemId)) return "farm";
    if (tags && tags.indexOf(HOE_TAG) >= 0) return "farm";
    return undefined;
}

/** 只按 id 判断是不是锄头（拿不到标签时用，比如槽位里的那件） */
export function isHoeId(itemId) {
    return !!itemId && HOES.includes(itemId);
}

/** 原版物品标签：任意镐 / 任意斧（1.26 的 ItemStack.getTags() 可读） */
export const PICKAXE_TAG = "minecraft:is_pickaxe";
export const AXE_TAG = "minecraft:is_axe";

/** 手持物 → 采集类别：'mine'（镐）/ 'chop'（斧）/ undefined。
 *  标签优先（覆盖模组镐斧），id 后缀兜底（标签读不到时）。_axe 后缀不会误伤 */
export function gatherKindOf(itemId, tags) {
    if (!itemId) return undefined;
    if (tags) {
        if (tags.indexOf(AXE_TAG) >= 0) return "chop";
        if (tags.indexOf(PICKAXE_TAG) >= 0) return "mine";
    }
    if (itemId.endsWith("_axe")) return "chop";
    if (itemId.endsWith("_pickaxe")) return "mine";
    return undefined;
}

/** 只按 id 判断是不是她的采集工具（归还时清替身用） */
export function isGatherToolId(itemId) {
    return gatherKindOf(itemId) !== undefined;
}

/** 手持物 → 武器形态键；不是武器返回 undefined
 *  @param {string[]} [tags] 有 minecraft:is_sword 也按剑处理 */
export function weaponFamilyOf(itemId, tags) {
    if (!itemId) return undefined;
    if (itemId === "minecraft:bow") return "bow";
    if (itemId === "minecraft:crossbow") return "crossbow";
    if (SWORDS.includes(itemId)) return "sword";
    if (tags && tags.indexOf(SWORD_TAG) >= 0) return "sword";
    // 长矛单开形态：组件组 spear + variant 8，事件 spear_on / spear_off。
    // 交互规则是 sword 的副本，只有外观与 RP 动画分开
    if (SPEARS.includes(itemId)) return "spear";
    if (tags && tags.indexOf(SPEAR_TAG) >= 0) return "spear";
    return undefined;
}
