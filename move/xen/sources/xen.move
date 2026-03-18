module xen_iota::xen {
    use iota::clock::{Self, Clock};
    use iota::coin::{Self, Coin, TreasuryCap};
    use iota::object::{Self, UID};
    use iota::table::{Self, Table};
    use iota::transfer;
    use iota::tx_context::{Self, TxContext};
    use iota::url::Url;
    use std::option;

    const DAY_MS: u64 = 86_400_000;
    const MAX_STAKE_TERM_DAYS: u64 = 1_000;
    const MIN_STAKE_TERM_DAYS: u64 = 1;

    const AMP_START: u64 = 3_000;
    const EAA_START_BPS: u64 = 1_000; // 10%
    const APY_START_BPS: u64 = 2_000; // 20%
    const APY_MIN_BPS: u64 = 200; // 2%

    const BPS_DENOM: u128 = 10_000;
    const U64_MAX_U128: u128 = 18_446_744_073_709_551_615;

    const ENoActiveMint: u64 = 1;
    const EInvalidTerm: u64 = 2;
    const ETooEarlyToClaim: u64 = 3;
    const EUnauthorized: u64 = 4;
    const EInvalidPct: u64 = 5;
    const EActiveStakeExists: u64 = 6;
    const ENoActiveStake: u64 = 7;
    const EOverflow: u64 = 8;
    const EInvalidStakeAmount: u64 = 9;

    /// One-time witness + token type.
    struct XEN has drop {}

    struct Protocol has key {
        id: UID,
        genesis_ts_ms: u64,
        global_rank: u64,
        treasury: TreasuryCap<XEN>,
        active_mints: Table<address, u64>,
        active_stakes: Table<address, bool>,
    }

    struct MintReceipt has key, store {
        id: UID,
        owner: address,
        c_rank: u64,
        term_days: u64,
        maturity_ts_ms: u64,
        amp_at_claim: u64,
    }

    struct StakeReceipt has key, store {
        id: UID,
        owner: address,
        principal: u64,
        term_days: u64,
        apy_bps: u64,
        maturity_ts_ms: u64,
    }

    fun init(witness: XEN, ctx: &mut TxContext) {
        let (treasury, metadata) = coin::create_currency<XEN>(
            witness,
            18,
            b"XENI",
            b"XEN on IOTA",
            b"Proof-of-Participation style tokenomics ported to IOTA Move",
            option::none<Url>(),
            ctx,
        );

        transfer::public_transfer(metadata, tx_context::sender(ctx));

        let protocol = Protocol {
            id: object::new(ctx),
            genesis_ts_ms: tx_context::epoch_timestamp_ms(ctx),
            global_rank: 0,
            treasury,
            active_mints: table::new<address, u64>(ctx),
            active_stakes: table::new<address, bool>(ctx),
        };

        transfer::share_object(protocol);
    }

    public entry fun claim_rank(protocol: &mut Protocol, clock: &Clock, term_days: u64, ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);

        let max_term = free_mint_term_limit(protocol.global_rank);
        assert!(term_days >= 1 && term_days <= max_term, EInvalidTerm);

        protocol.global_rank = protocol.global_rank + 1;
        let c_rank = protocol.global_rank;

        let now_ms = clock::timestamp_ms(clock);
        let maturity_ts_ms = now_ms + term_days * DAY_MS;
        let amp_now = current_amp(protocol, clock);

        let receipt = MintReceipt {
            id: object::new(ctx),
            owner: sender,
            c_rank,
            term_days,
            maturity_ts_ms,
            amp_at_claim: amp_now,
        };

        bump_active_mint_count(protocol, sender);
        transfer::public_transfer(receipt, sender);
    }

    public entry fun claim_mint_reward(protocol: &mut Protocol, clock: &Clock, receipt: MintReceipt, ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        let amount = settle_mint_amount(protocol, clock, &receipt, sender);
        cleanup_mint(protocol, receipt, sender);

        let payout = coin::mint(&mut protocol.treasury, amount, ctx);
        transfer::public_transfer(payout, sender);
    }

    public entry fun claim_mint_reward_and_share(
        protocol: &mut Protocol,
        clock: &Clock,
        receipt: MintReceipt,
        other: address,
        pct: u64,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(pct <= 100, EInvalidPct);

        let amount = settle_mint_amount(protocol, clock, &receipt, sender);
        cleanup_mint(protocol, receipt, sender);

        let payout = coin::mint(&mut protocol.treasury, amount, ctx);
        let share_amount = clamp_u64((amount as u128) * (pct as u128) / 100);
        if (share_amount > 0) {
            let shared = coin::split(&mut payout, share_amount, ctx);
            transfer::public_transfer(shared, other);
        };

        transfer_or_destroy_zero(payout, sender);
    }

    public entry fun claim_mint_reward_and_stake(
        protocol: &mut Protocol,
        clock: &Clock,
        receipt: MintReceipt,
        pct_to_stake: u64,
        stake_term_days: u64,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(pct_to_stake <= 100, EInvalidPct);
        assert!(stake_term_days >= MIN_STAKE_TERM_DAYS && stake_term_days <= MAX_STAKE_TERM_DAYS, EInvalidTerm);

        let amount = settle_mint_amount(protocol, clock, &receipt, sender);
        cleanup_mint(protocol, receipt, sender);

        let payout = coin::mint(&mut protocol.treasury, amount, ctx);
        let stake_amount = clamp_u64((amount as u128) * (pct_to_stake as u128) / 100);

        if (stake_amount > 0) {
            assert!(!table::contains(&protocol.active_stakes, sender), EActiveStakeExists);
            let to_stake = coin::split(&mut payout, stake_amount, ctx);
            let principal = coin::burn(&mut protocol.treasury, to_stake);
            create_stake_receipt(protocol, clock, sender, principal, stake_term_days, ctx);
        };

        transfer_or_destroy_zero(payout, sender);
    }

    public entry fun stake(
        protocol: &mut Protocol,
        clock: &Clock,
        coin_in: Coin<XEN>,
        amount: u64,
        term_days: u64,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(!table::contains(&protocol.active_stakes, sender), EActiveStakeExists);
        assert!(term_days >= MIN_STAKE_TERM_DAYS && term_days <= MAX_STAKE_TERM_DAYS, EInvalidTerm);

        let total = coin::value(&coin_in);
        assert!(amount > 0 && amount <= total, EInvalidStakeAmount);

        let to_stake = coin::split(&mut coin_in, amount, ctx);
        let principal = coin::burn(&mut protocol.treasury, to_stake);

        create_stake_receipt(protocol, clock, sender, principal, term_days, ctx);
        transfer_or_destroy_zero(coin_in, sender);
    }

    public entry fun withdraw(protocol: &mut Protocol, clock: &Clock, receipt: StakeReceipt, ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        assert!(receipt.owner == sender, EUnauthorized);
        assert!(table::contains(&protocol.active_stakes, sender), ENoActiveStake);
        let _removed = table::remove(&mut protocol.active_stakes, sender);

        let now_ms = clock::timestamp_ms(clock);
        let reward = if (now_ms >= receipt.maturity_ts_ms) {
            stake_reward(receipt.principal, receipt.apy_bps, receipt.term_days)
        } else {
            0
        };

        let total = receipt.principal + reward;
        let payout = coin::mint(&mut protocol.treasury, total, ctx);
        transfer::public_transfer(payout, sender);

        let StakeReceipt {
            id,
            owner: _,
            principal: _,
            term_days: _,
            apy_bps: _,
            maturity_ts_ms: _,
        } = receipt;
        object::delete(id);
    }

    // ==== Views ====

    public fun get_global_rank(protocol: &Protocol): u64 {
        protocol.global_rank
    }

    public fun get_free_mint_term_limit(protocol: &Protocol): u64 {
        free_mint_term_limit(protocol.global_rank)
    }

    public fun get_current_amp(protocol: &Protocol, clock: &Clock): u64 {
        current_amp(protocol, clock)
    }

    public fun get_current_apy_bps(protocol: &Protocol, clock: &Clock): u64 {
        current_apy_bps(protocol, clock)
    }

    // ==== Internal helpers ====

    fun settle_mint_amount(protocol: &Protocol, clock: &Clock, receipt: &MintReceipt, sender: address): u64 {
        assert!(receipt.owner == sender, EUnauthorized);
        assert!(table::contains(&protocol.active_mints, sender), ENoActiveMint);

        let now_ms = clock::timestamp_ms(clock);
        assert!(now_ms >= receipt.maturity_ts_ms, ETooEarlyToClaim);

        let rank_delta = if (protocol.global_rank > receipt.c_rank) {
            protocol.global_rank - receipt.c_rank
        } else {
            1
        };

        let log_rank = floor_log2(rank_delta);
        let eaa_bps = eaa_bps_for_rank(receipt.c_rank);

        let gross_u128 = (log_rank as u128) * (receipt.term_days as u128) * (receipt.amp_at_claim as u128)
            * (BPS_DENOM + (eaa_bps as u128)) / BPS_DENOM;
        let gross = clamp_u64(gross_u128);

        let late_days = (now_ms - receipt.maturity_ts_ms) / DAY_MS;
        let penalty_pct = late_penalty_pct(late_days);

        clamp_u64((gross as u128) * ((100 - penalty_pct) as u128) / 100)
    }

    fun cleanup_mint(protocol: &mut Protocol, receipt: MintReceipt, sender: address) {
        reduce_active_mint_count(protocol, sender);

        let MintReceipt {
            id,
            owner: _,
            c_rank: _,
            term_days: _,
            maturity_ts_ms: _,
            amp_at_claim: _,
        } = receipt;
        object::delete(id);
    }

    fun bump_active_mint_count(protocol: &mut Protocol, sender: address) {
        if (table::contains(&protocol.active_mints, sender)) {
            let count_ref = table::borrow_mut(&mut protocol.active_mints, sender);
            *count_ref = *count_ref + 1;
        } else {
            table::add(&mut protocol.active_mints, sender, 1);
        };
    }

    fun reduce_active_mint_count(protocol: &mut Protocol, sender: address) {
        assert!(table::contains(&protocol.active_mints, sender), ENoActiveMint);
        let count = *table::borrow(&protocol.active_mints, sender);
        if (count <= 1) {
            let _removed = table::remove(&mut protocol.active_mints, sender);
        } else {
            let count_ref = table::borrow_mut(&mut protocol.active_mints, sender);
            *count_ref = count - 1;
        };
    }

    fun create_stake_receipt(
        protocol: &mut Protocol,
        clock: &Clock,
        owner: address,
        principal: u64,
        term_days: u64,
        ctx: &mut TxContext,
    ) {
        let now_ms = clock::timestamp_ms(clock);
        let receipt = StakeReceipt {
            id: object::new(ctx),
            owner,
            principal,
            term_days,
            apy_bps: current_apy_bps(protocol, clock),
            maturity_ts_ms: now_ms + term_days * DAY_MS,
        };

        table::add(&mut protocol.active_stakes, owner, true);
        transfer::public_transfer(receipt, owner);
    }

    fun transfer_or_destroy_zero(c: Coin<XEN>, recipient: address) {
        if (coin::value(&c) == 0) {
            coin::destroy_zero(c);
        } else {
            transfer::public_transfer(c, recipient);
        };
    }

    fun free_mint_term_limit(global_rank: u64): u64 {
        if (global_rank <= 5_000) {
            100
        } else {
            100 + floor_log2(global_rank) * 15
        }
    }

    fun current_amp(protocol: &Protocol, clock: &Clock): u64 {
        amp_at(clock::timestamp_ms(clock), protocol.genesis_ts_ms)
    }

    fun amp_at(now_ms: u64, genesis_ts_ms: u64): u64 {
        let days_since = if (now_ms > genesis_ts_ms) {
            (now_ms - genesis_ts_ms) / DAY_MS
        } else {
            0
        };

        if (days_since >= AMP_START - 1) {
            1
        } else {
            AMP_START - days_since
        }
    }

    fun eaa_bps_for_rank(rank: u64): u64 {
        let decay = (rank / 100_000) * 10;
        if (decay >= EAA_START_BPS) {
            0
        } else {
            EAA_START_BPS - decay
        }
    }

    fun current_apy_bps(protocol: &Protocol, clock: &Clock): u64 {
        let now_ms = clock::timestamp_ms(clock);
        let days_since = if (now_ms > protocol.genesis_ts_ms) {
            (now_ms - protocol.genesis_ts_ms) / DAY_MS
        } else {
            0
        };

        let decay = (days_since / 90) * 100;
        if (decay >= APY_START_BPS - APY_MIN_BPS) {
            APY_MIN_BPS
        } else {
            APY_START_BPS - decay
        }
    }

    fun stake_reward(principal: u64, apy_bps: u64, term_days: u64): u64 {
        clamp_u64((principal as u128) * (apy_bps as u128) * (term_days as u128) / BPS_DENOM / 365)
    }

    fun late_penalty_pct(days_late: u64): u64 {
        if (days_late == 0) {
            0
        } else if (days_late == 1) {
            1
        } else if (days_late == 2) {
            3
        } else if (days_late == 3) {
            8
        } else if (days_late == 4) {
            17
        } else if (days_late == 5) {
            35
        } else if (days_late == 6) {
            72
        } else {
            99
        }
    }

    fun floor_log2(x: u64): u64 {
        let n = 0;
        while (x > 1) {
            x = x / 2;
            n = n + 1;
        };
        n
    }

    fun clamp_u64(v: u128): u64 {
        assert!(v <= U64_MAX_U128, EOverflow);
        (v as u64)
    }

    #[test]
    fun test_floor_log2() {
        assert!(floor_log2(1) == 0, 100);
        assert!(floor_log2(2) == 1, 101);
        assert!(floor_log2(3) == 1, 102);
        assert!(floor_log2(4) == 2, 103);
        assert!(floor_log2(5001) == 12, 104);
    }

    #[test]
    fun test_free_mint_term_limit() {
        assert!(free_mint_term_limit(1) == 100, 110);
        assert!(free_mint_term_limit(5_000) == 100, 111);
        assert!(free_mint_term_limit(5_001) == 280, 112);
    }

    #[test]
    fun test_amp_schedule() {
        assert!(amp_at(0, 0) == 3_000, 120);
        assert!(amp_at(DAY_MS, 0) == 2_999, 121);
        assert!(amp_at(DAY_MS * 10_000, 0) == 1, 122);
    }

    #[test]
    fun test_eaa_decay() {
        assert!(eaa_bps_for_rank(1) == 1_000, 130);
        assert!(eaa_bps_for_rank(100_000) == 990, 131);
        assert!(eaa_bps_for_rank(1_000_000) == 900, 132);
    }

    #[test]
    fun test_penalty_schedule() {
        assert!(late_penalty_pct(0) == 0, 140);
        assert!(late_penalty_pct(1) == 1, 141);
        assert!(late_penalty_pct(2) == 3, 142);
        assert!(late_penalty_pct(3) == 8, 143);
        assert!(late_penalty_pct(4) == 17, 144);
        assert!(late_penalty_pct(5) == 35, 145);
        assert!(late_penalty_pct(6) == 72, 146);
        assert!(late_penalty_pct(7) == 99, 147);
        assert!(late_penalty_pct(100) == 99, 148);
    }

    #[test]
    fun test_stake_reward() {
        // 1000 * 20% * 365/365 = 200
        assert!(stake_reward(1_000, 2_000, 365) == 200, 150);
        // 1000 * 10% * 30/365 ~= 8 (floored)
        assert!(stake_reward(1_000, 1_000, 30) == 8, 151);
    }

    #[test_only]
    fun test_init_for_scenario(s: &mut iota::test_scenario::Scenario) {
        let ctx = iota::test_scenario::ctx(s);
        let protocol = Protocol {
            id: object::new(ctx),
            genesis_ts_ms: tx_context::epoch_timestamp_ms(ctx),
            global_rank: 0,
            treasury: coin::create_treasury_cap_for_testing<XEN>(ctx),
            active_mints: table::new<address, u64>(ctx),
            active_stakes: table::new<address, bool>(ctx),
        };
        transfer::share_object(protocol);
    }

    #[test]
    #[expected_failure(abort_code = ETooEarlyToClaim)]
    fun test_e2e_claim_too_early_fails() {
        let alice = @0xA11CE;
        let s = iota::test_scenario::begin(alice);
        test_init_for_scenario(&mut s);

        let clock = clock::create_for_testing(iota::test_scenario::ctx(&mut s));

        iota::test_scenario::next_tx(&mut s, alice);
        {
            let p: Protocol = iota::test_scenario::take_shared<Protocol>(&s);
            claim_rank(&mut p, &clock, 7, iota::test_scenario::ctx(&mut s));
            iota::test_scenario::return_shared(p);
        };

        iota::test_scenario::next_tx(&mut s, alice);
        {
            let p: Protocol = iota::test_scenario::take_shared<Protocol>(&s);
            let receipt: MintReceipt = iota::test_scenario::take_from_sender<MintReceipt>(&s);
            claim_mint_reward(&mut p, &clock, receipt, iota::test_scenario::ctx(&mut s));
            iota::test_scenario::return_shared(p);
        };

        clock::destroy_for_testing(clock);
        iota::test_scenario::end(s);
    }

    #[test]
    fun test_e2e_maturity_and_late_penalty() {
        let alice = @0xA11CE;
        let bob = @0xB0B;
        let carol = @0xCA70;

        let s = iota::test_scenario::begin(alice);
        test_init_for_scenario(&mut s);

        let clock = clock::create_for_testing(iota::test_scenario::ctx(&mut s));

        iota::test_scenario::next_tx(&mut s, alice);
        {
            let p: Protocol = iota::test_scenario::take_shared<Protocol>(&s);
            claim_rank(&mut p, &clock, 7, iota::test_scenario::ctx(&mut s));
            iota::test_scenario::return_shared(p);
        };

        // Two more ranks so Alice has positive reward (rank_delta >= 2).
        iota::test_scenario::next_tx(&mut s, bob);
        {
            let p: Protocol = iota::test_scenario::take_shared<Protocol>(&s);
            claim_rank(&mut p, &clock, 1, iota::test_scenario::ctx(&mut s));
            iota::test_scenario::return_shared(p);
        };

        iota::test_scenario::next_tx(&mut s, carol);
        {
            let p: Protocol = iota::test_scenario::take_shared<Protocol>(&s);
            claim_rank(&mut p, &clock, 1, iota::test_scenario::ctx(&mut s));
            iota::test_scenario::return_shared(p);
        };

        iota::test_scenario::next_tx(&mut s, alice);
        {
            clock::increment_for_testing(&mut clock, 7 * DAY_MS);

            let p: Protocol = iota::test_scenario::take_shared<Protocol>(&s);
            let receipt: MintReceipt = iota::test_scenario::take_from_sender<MintReceipt>(&s);

            let on_time = settle_mint_amount(&p, &clock, &receipt, alice);
            assert!(on_time > 0, 160);

            clock::increment_for_testing(&mut clock, 7 * DAY_MS);
            let late = settle_mint_amount(&p, &clock, &receipt, alice);
            assert!(late < on_time, 161);

            claim_mint_reward(&mut p, &clock, receipt, iota::test_scenario::ctx(&mut s));
            iota::test_scenario::return_shared(p);
        };

        iota::test_scenario::next_tx(&mut s, alice);
        {
            let payout: Coin<XEN> = iota::test_scenario::take_from_sender<Coin<XEN>>(&s);
            assert!(coin::value(&payout) > 0, 162);
            iota::test_scenario::return_to_sender(&s, payout);
        };

        clock::destroy_for_testing(clock);
        iota::test_scenario::end(s);
    }

    #[test]
    fun test_e2e_stake_withdraw_early_no_reward() {
        let alice = @0xA11CE;

        let s = iota::test_scenario::begin(alice);
        test_init_for_scenario(&mut s);

        let clock = clock::create_for_testing(iota::test_scenario::ctx(&mut s));

        iota::test_scenario::next_tx(&mut s, alice);
        {
            let p: Protocol = iota::test_scenario::take_shared<Protocol>(&s);
            let c = coin::mint(&mut p.treasury, 1_000, iota::test_scenario::ctx(&mut s));
            stake(&mut p, &clock, c, 1_000, 30, iota::test_scenario::ctx(&mut s));
            iota::test_scenario::return_shared(p);
        };

        iota::test_scenario::next_tx(&mut s, alice);
        {
            let p: Protocol = iota::test_scenario::take_shared<Protocol>(&s);
            let r: StakeReceipt = iota::test_scenario::take_from_sender<StakeReceipt>(&s);
            withdraw(&mut p, &clock, r, iota::test_scenario::ctx(&mut s));
            iota::test_scenario::return_shared(p);
        };

        iota::test_scenario::next_tx(&mut s, alice);
        {
            let payout: Coin<XEN> = iota::test_scenario::take_from_sender<Coin<XEN>>(&s);
            assert!(coin::value(&payout) == 1_000, 170);
            iota::test_scenario::return_to_sender(&s, payout);
        };

        clock::destroy_for_testing(clock);
        iota::test_scenario::end(s);
    }

    #[test]
    fun test_e2e_stake_withdraw_after_maturity_with_reward() {
        let alice = @0xA11CE;

        let s = iota::test_scenario::begin(alice);
        test_init_for_scenario(&mut s);

        let clock = clock::create_for_testing(iota::test_scenario::ctx(&mut s));

        iota::test_scenario::next_tx(&mut s, alice);
        {
            let p: Protocol = iota::test_scenario::take_shared<Protocol>(&s);
            let c = coin::mint(&mut p.treasury, 1_000, iota::test_scenario::ctx(&mut s));
            stake(&mut p, &clock, c, 1_000, 30, iota::test_scenario::ctx(&mut s));
            iota::test_scenario::return_shared(p);
        };

        iota::test_scenario::next_tx(&mut s, alice);
        {
            clock::increment_for_testing(&mut clock, 30 * DAY_MS);

            let p: Protocol = iota::test_scenario::take_shared<Protocol>(&s);
            let r: StakeReceipt = iota::test_scenario::take_from_sender<StakeReceipt>(&s);
            let expected = stake_reward(r.principal, r.apy_bps, r.term_days);
            withdraw(&mut p, &clock, r, iota::test_scenario::ctx(&mut s));
            iota::test_scenario::return_shared(p);

            // Store expected by checking payout in next tx (most recent coin transfer).
            assert!(expected > 0, 171);
        };

        iota::test_scenario::next_tx(&mut s, alice);
        {
            let payout: Coin<XEN> = iota::test_scenario::take_from_sender<Coin<XEN>>(&s);
            assert!(coin::value(&payout) > 1_000, 172);
            iota::test_scenario::return_to_sender(&s, payout);
        };

        clock::destroy_for_testing(clock);
        iota::test_scenario::end(s);
    }
}
