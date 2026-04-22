import {XMLParser} from 'fast-xml-parser'
import kvvXml from '../../bills/kvv.xml'
import type {Env} from '../shared/types'
import {getSupabaseClient} from '../shared/supabase'

export type BillData = {
    billNumber: string
    issueDate: string
    dueDate: string
    payerName: string
    description: string
    quantity: number
    unitPrice: string
    total: string
    issuer: {
        name: string
        address: string
        regCode: string
        phone: string
        bankName: string
        iban: string
    }
    signatory: string
}

type ParsedEntry = {
    iban: string
    instrId: string
    debtorName: string
    remittanceInfo: string
    amount: string
}

const INVISIBLE_CONTROL_REGEX = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g

function stripInvisibleControls(input: string): string {
    return input.replace(INVISIBLE_CONTROL_REGEX, '')
}

/** Trim and remove all whitespace (grouped IBAN input). */
export function normalizeIban(input: string): string {
    return stripInvisibleControls(input)
        .normalize('NFKC')
        .trim()
        .replace(/\s+/g, '')
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase()
}

/**
 * Payer name for lookup: strip invisible controls, NFKC, trim, remove all whitespace,
 * then uppercase (et-EE for correct handling of i/õäöü).
 */
export function normalizePayerName(input: string): string {
    const collapsed = stripInvisibleControls(input).normalize('NFKC').trim().replace(/\s+/g, '')
    return collapsed.toLocaleUpperCase('et-EE')
}

let cachedEntries: ParsedEntry[] | null = null

function parseEntries(): ParsedEntry[] {
    if (cachedEntries) return cachedEntries

    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        numberParseOptions: {hex: false, leadingZeros: false, skipLike: /./},
    })
    const doc = parser.parse(kvvXml)

    const stmt = doc?.Document?.BkToCstmrStmt?.Stmt
    if (!stmt) return []

    const rawEntries = stmt.Ntry
    const entries: ParsedEntry[] = []

    const list = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : []

    for (const ntry of list) {
        const amt = typeof ntry.Amt === 'object' ? String(ntry.Amt['#text']) : String(ntry.Amt ?? '')
        const txDtls = ntry.NtryDtls?.TxDtls
        if (!txDtls) continue

        const refs = txDtls.Refs
        const instrId = String(refs?.InstrId ?? '')
        const debtorName = String(txDtls.RltdPties?.Dbtr?.Nm ?? '')
        const iban = String(txDtls.RltdPties?.DbtrAcct?.Id?.IBAN ?? '')
        const remittanceInfo = String(txDtls.RmtInf?.Ustrd ?? '')

        if (!normalizeIban(iban) || !normalizePayerName(debtorName)) continue

        entries.push({iban, instrId, debtorName, remittanceInfo, amount: amt})
    }

    cachedEntries = entries
    return entries
}

/** `iban` and `payerName` must already be normalized (see routes). */
export function findTransaction(iban: string, payerName: string): ParsedEntry | null {
    const entries = parseEntries()
    return (
        entries.find(
            (e) => normalizeIban(e.iban) === iban && normalizePayerName(e.debtorName) === payerName,
        ) ?? null
    )
}

export function buildBillData(
    tx: ParsedEntry,
    competitionId: number,
    playerId: number,
): BillData {
    const today = new Date().toLocaleDateString('et-EE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
    })

    return {
        billNumber: `JJ100-${competitionId}-${playerId}`,
        issueDate: today,
        dueDate: today,
        payerName: tx.debtorName,
        description: tx.remittanceInfo,
        quantity: 1,
        unitPrice: tx.amount,
        total: tx.amount,
        issuer: {
            name: 'MTÜ Järva-Jaani Discgolfi Klubi',
            address: 'Järva-Jaani, 73301',
            regCode: '80383274',
            phone: '5257373',
            bankName: 'SEB pank',
            iban: 'EE751010220241724229',
        },
        signatory: 'Arto Saar',
    }
}

/** Insert or refresh audit row (unique player_id + bill_number). Does not throw. */
export async function recordPlayerBillIssued(env: Env, playerId: number, billNumber: string): Promise<void> {
    const supabase = getSupabaseClient(env)
    const requested_date = new Date().toISOString()
    const {error} = await supabase.from('player_bill').upsert(
        {player_id: playerId, bill_number: billNumber, requested_date},
        {onConflict: 'player_id,bill_number'},
    )
    if (error) {
        console.error('[player_bill] upsert failed:', error)
    }
}
