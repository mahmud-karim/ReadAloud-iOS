import SwiftUI
import AVFoundation

/// The app only explains how to turn the extension on; the work happens in Safari.
struct ContentView: View {
    @State private var speaker = AVSpeechSynthesizer()

    private let sample = "Highlight any text on a web page, then tap the speaker button that appears at the bottom of the screen. Read Aloud speaks it and marks each word as it goes."

    var body: some View {
        NavigationStack {
            List {
                Section("Turn it on") {
                    step(1, "Open the Settings app.")
                    step(2, "Go to Apps, then Safari, then Extensions.")
                    step(3, "Tap Read Aloud and switch it on.")
                    step(4, "Set All Websites to Allow, so it works on every page.")
                }
                Section("Use it") {
                    step(1, "In Safari, highlight some text.")
                    step(2, "Tap the round speaker button at the bottom.")
                    step(3, "Use the bar to pause, skip or stop.")
                    Text("Voice, speed and your own speech server are in the puzzle-piece menu in Safari's address bar, under Read Aloud.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Try the voice") {
                    Text(sample).font(.callout)
                    Button("Speak this sample") {
                        speaker.stopSpeaking(at: .immediate)
                        speaker.speak(AVSpeechUtterance(string: sample))
                    }
                }
            }
            .navigationTitle("Read Aloud")
        }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(n)").font(.headline).foregroundStyle(.tint)
            Text(text)
        }
    }
}
