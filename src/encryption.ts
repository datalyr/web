/**
 * Encryption Module (SEC-03 Fix)
 *
 * Encrypts sensitive PII data before storing in localStorage
 * Uses Web Crypto API for AES-GCM encryption
 *
 * SECURITY NOTE: This protects against casual localStorage reads,
 * but determined XSS attacks can still access the encryption key in memory.
 * Primary defense is preventing XSS (see container.ts sandboxing).
 */

export class DataEncryption {
  private key: CryptoKey | null = null;
  private salt: Uint8Array | null = null;

  /**
   * Initialize encryption with workspace-specific key
   *
   * FIXED (SEC-03): Now uses random per-device salt stored in localStorage
   *
   * @param workspaceId - Used to derive encryption key
   * @param deviceId - Device-specific identifier for key derivation
   */
  async initialize(workspaceId: string, deviceId: string): Promise<void> {
    if (!crypto.subtle) {
      const error = new Error('Web Crypto API not available - encryption cannot be initialized');
      console.error('[Datalyr Encryption]', error.message);
      throw error; // FIXED: Fail loudly instead of silently
    }

    try {
      const encoder = new TextEncoder();

      // FIXED (SEC-03): Generate or retrieve random per-device salt
      const saltKey = 'dl_encryption_salt';
      let saltBase64 = localStorage.getItem(saltKey);

      if (!saltBase64) {
        // Generate new random 32-byte salt
        this.salt = crypto.getRandomValues(new Uint8Array(32));
        saltBase64 = this.arrayBufferToBase64(this.salt);
        localStorage.setItem(saltKey, saltBase64);
      } else {
        // Use existing salt
        this.salt = this.base64ToArrayBuffer(saltBase64);
      }

      // Derive key material from workspace ID + device ID
      const keyString = `datalyr:${workspaceId}:${deviceId}`;
      const keyData = encoder.encode(keyString);

      // Import key material
      const baseKey = await crypto.subtle.importKey(
        'raw',
        keyData,
        'PBKDF2',
        false,
        ['deriveKey']
      );

      // Derive actual encryption key using PBKDF2 with random salt
      this.key = await crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: this.salt as BufferSource, // FIXED: Random per-device salt instead of static
          iterations: 100000, // 100k iterations for security
          hash: 'SHA-256'
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

    } catch (error) {
      console.error('[Datalyr Encryption] Failed to initialize:', error);
      this.key = null;
      throw error; // FIXED: Fail loudly
    }
  }

  /**
   * Encrypt sensitive data
   *
   * FIXED (SEC-03): No longer silently falls back to unencrypted storage
   *
   * @param data - Plain text or object to encrypt
   * @returns Base64-encoded encrypted data with IV
   * @throws Error if encryption is not available or fails
   */
  async encrypt(data: any): Promise<string> {
    if (!this.key || !crypto.subtle) {
      // FIXED: Fail loudly instead of silently storing unencrypted
      throw new Error('Encryption not initialized - cannot encrypt sensitive data');
    }

    try {
      const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
      const encoder = new TextEncoder();
      const plaintextBytes = encoder.encode(plaintext);

      // Generate random IV (Initialization Vector)
      const iv = crypto.getRandomValues(new Uint8Array(12)); // 12 bytes for GCM

      // Encrypt
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        this.key,
        plaintextBytes
      );

      // Combine IV + ciphertext for storage
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);

      // Return base64-encoded
      return this.arrayBufferToBase64(combined);

    } catch (error) {
      console.error('[Datalyr Encryption] Encryption failed:', error);
      throw error; // FIXED: Fail loudly
    }
  }

  /**
   * Decrypt sensitive data
   *
   * FIXED (SEC-03): Still allows backwards compatibility for migration,
   * but logs warnings when unencrypted data is detected
   *
   * @param encryptedData - Base64-encoded encrypted data
   * @returns Decrypted data (parsed as JSON if possible)
   */
  async decrypt(encryptedData: string): Promise<any> {
    if (!this.key || !crypto.subtle) {
      // Backwards compatibility: Try to parse as unencrypted JSON
      console.warn('[Datalyr Encryption] Decryption not available - reading potentially unencrypted data');
      try {
        return JSON.parse(encryptedData);
      } catch {
        return encryptedData;
      }
    }

    try {
      // Decode base64
      const combined = this.base64ToArrayBuffer(encryptedData);

      // Extract IV (first 12 bytes) and ciphertext
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);

      // Decrypt
      const plaintextBytes = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        this.key,
        ciphertext
      );

      // Decode and parse
      const decoder = new TextDecoder();
      const plaintext = decoder.decode(plaintextBytes);

      // Try to parse as JSON
      try {
        return JSON.parse(plaintext);
      } catch {
        return plaintext;
      }

    } catch (error) {
      // Backwards compatibility: Try to parse as unencrypted (for migration)
      console.warn('[Datalyr Encryption] Decryption failed - attempting to read as unencrypted data (migration mode)');
      try {
        return JSON.parse(encryptedData);
      } catch {
        return encryptedData;
      }
    }
  }

  /**
   * Check if encryption is available and initialized
   */
  isAvailable(): boolean {
    return this.key !== null && crypto.subtle !== undefined;
  }

  /**
   * Helper: Convert ArrayBuffer to Base64
   */
  private arrayBufferToBase64(buffer: Uint8Array): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Helper: Convert Base64 to ArrayBuffer
   */
  private base64ToArrayBuffer(base64: string): Uint8Array {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Destroy encryption keys (called on SDK destroy)
   *
   * FIXED (SEC-03): Also clears salt reference
   */
  destroy(): void {
    this.key = null;
    this.salt = null;
  }
}

// Singleton instance
export const dataEncryption = new DataEncryption();
