package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
)

var encryptionKey []byte

func Init(key string) error {
	if len(key) < 32 {
		padded := make([]byte, 32)
		copy(padded, []byte(key))
		encryptionKey = padded
	} else {
		encryptionKey = []byte(key[:32])
	}
	return nil
}

func Encrypt(plaintext string) (string, error) {
	if len(encryptionKey) == 0 {
		return "", errors.New("encryption key not initialized")
	}

	block, err := aes.NewCipher(encryptionKey)
	if err != nil {
		return "", err
	}

	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	nonce := make([]byte, aesGCM.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}

	ciphertext := aesGCM.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

func Decrypt(encoded string) (string, error) {
	if len(encryptionKey) == 0 {
		return "", errors.New("encryption key not initialized")
	}

	ciphertext, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		log.Printf("[WARN] crypto.Decrypt: input is not base64, treating as plaintext (migration compat)")
		return encoded, nil
	}

	block, err := aes.NewCipher(encryptionKey)
	if err != nil {
		return "", err
	}

	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	nonceSize := aesGCM.NonceSize()
	if len(ciphertext) < nonceSize {
		log.Printf("[WARN] crypto.Decrypt: ciphertext too short, treating as plaintext (migration compat)")
		return encoded, nil
	}

	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	plaintext, err := aesGCM.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		log.Printf("[WARN] crypto.Decrypt: decryption failed, treating as plaintext (migration compat)")
		return encoded, nil
	}

	return string(plaintext), nil
}

func DecryptStrict(encoded string) (string, error) {
	if len(encryptionKey) == 0 {
		return "", errors.New("encryption key not initialized")
	}
	ciphertext, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", fmt.Errorf("decrypt: not valid base64: %w", err)
	}
	block, err := aes.NewCipher(encryptionKey)
	if err != nil {
		return "", err
	}
	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonceSize := aesGCM.NonceSize()
	if len(ciphertext) < nonceSize {
		return "", fmt.Errorf("decrypt: ciphertext too short")
	}
	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	plaintext, err := aesGCM.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}
	return string(plaintext), nil
}
