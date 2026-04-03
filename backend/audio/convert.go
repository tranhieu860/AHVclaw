package audio

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
)

func HasFFmpeg() bool {
	_, err := exec.LookPath("ffmpeg")
	return err == nil
}

func MP3ToOGG(mp3Data []byte) ([]byte, error) {
	tmpDir := os.TempDir()
	inFile := filepath.Join(tmpDir, fmt.Sprintf("tts-%d.mp3", os.Getpid()))
	outFile := filepath.Join(tmpDir, fmt.Sprintf("tts-%d.ogg", os.Getpid()))
	defer os.Remove(inFile)
	defer os.Remove(outFile)

	if err := os.WriteFile(inFile, mp3Data, 0644); err != nil {
		return nil, fmt.Errorf("write temp MP3: %w", err)
	}

	cmd := exec.Command("ffmpeg", "-y", "-i", inFile, "-c:a", "libopus", "-b:a", "48k", outFile)
	if output, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("ffmpeg MP3->OGG failed: %w\n%s", err, string(output))
	}

	oggData, err := os.ReadFile(outFile)
	if err != nil {
		return nil, fmt.Errorf("read OGG output: %w", err)
	}

	log.Printf("[audio/convert] MP3 (%d bytes) -> OGG (%d bytes)", len(mp3Data), len(oggData))
	return oggData, nil
}

func WebMToWAV(webmData []byte) ([]byte, error) {
	tmpDir := os.TempDir()
	inFile := filepath.Join(tmpDir, fmt.Sprintf("rec-%d.webm", os.Getpid()))
	outFile := filepath.Join(tmpDir, fmt.Sprintf("rec-%d.wav", os.Getpid()))
	defer os.Remove(inFile)
	defer os.Remove(outFile)

	if err := os.WriteFile(inFile, webmData, 0644); err != nil {
		return nil, fmt.Errorf("write temp WebM: %w", err)
	}

	cmd := exec.Command("ffmpeg", "-y", "-i", inFile, "-ar", "16000", "-ac", "1", outFile)
	if output, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("ffmpeg WebM->WAV failed: %w\n%s", err, string(output))
	}

	wavData, err := os.ReadFile(outFile)
	if err != nil {
		return nil, fmt.Errorf("read WAV output: %w", err)
	}
	return wavData, nil
}
