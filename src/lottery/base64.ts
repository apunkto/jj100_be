/** Base64 encode a UTF-8 string (btoa only supports Latin1). */
export function base64EncodeUtf8(str: string): string {
    const bytes = new TextEncoder().encode(str)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!)
    }
    return btoa(binary)
}

/** Base64 decode to UTF-8 string. */
export function base64DecodeUtf8(base64: string): string {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return new TextDecoder().decode(bytes)
}
