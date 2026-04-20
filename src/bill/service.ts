import {XMLParser} from 'fast-xml-parser'
import kvvXml from '../../bills/kvv.xml'

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

/** Trim and remove all whitespace (grouped IBAN input). */
export function normalizeIban(input: string): string {
    return input.trim().replace(/\s+/g, '').toUpperCase()
}

/** Trim, remove whitespace, then remove hyphens for maksekorraldus comparison. */
export function normalizeInstructionId(input: string): string {
    return input.trim().replace(/\s+/g, '').replace(/-/g, '')
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

        if (!instrId) continue

        entries.push({iban, instrId, debtorName, remittanceInfo, amount: amt})
    }

    cachedEntries = entries
    return entries
}

/** `iban` and `instructionId` must already be normalized (see routes). */
export function findTransaction(iban: string, instructionId: string): ParsedEntry | null {
    const entries = parseEntries()
    return (
        entries.find(
            (e) =>
                normalizeIban(e.iban) === iban && normalizeInstructionId(e.instrId) === instructionId,
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
