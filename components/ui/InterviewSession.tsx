"use client";

import {
  RoomAudioRenderer,
  SessionProvider,
  useAgent,
  useLocalParticipant,
  useSession,
  useSessionContext,
  useSessionMessages,
} from "@livekit/components-react";
import {
  ConnectionState,
  ParticipantKind,
  RoomEvent,
  TokenSource,
} from "livekit-client";
import { Loader2, Mic, MicOff, PhoneOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../shadcn/button";

interface InterviewSessionProps {
  token: string;
  serverUrl: string;
  roundTitle: string;
  jobTitle?: string;
  onClose: () => void;
}

export function InterviewSession({
  token,
  serverUrl,
  roundTitle,
  jobTitle,
  onClose,
}: InterviewSessionProps) {
  const tokenSource = useMemo(
    () => TokenSource.literal({ serverUrl, participantToken: token }),
    [serverUrl, token],
  );

  const session = useSession(tokenSource);
  const hasStartedRef = useRef(false);

  useEffect(() => {
    if (hasStartedRef.current) return;
    if (session.connectionState !== ConnectionState.Disconnected) return;

    hasStartedRef.current = true;
    void session.start({
      tracks: {
        microphone: { enabled: true },
        camera: { enabled: false },
      },
    });
  }, [session]);

  return (
    <SessionProvider session={session}>
      <RoomAudioRenderer room={session.room} />
      <SessionLayout
        jobTitle={jobTitle}
        roundTitle={roundTitle}
        onClose={onClose}
      />
    </SessionProvider>
  );
}

const STATE_LABEL: Record<string, string> = {
  connecting: "Connecting…",
  initializing: "Connecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
  failed: "Connection failed",
};

function SessionLayout({
  roundTitle,
  jobTitle,
  onClose,
}: {
  roundTitle: string;
  jobTitle?: string;
  onClose: () => void;
}) {
  const session = useSessionContext();
  const agent = useAgent();
  const { messages } = useSessionMessages(session);
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();

  const [latestMessage, setLatestMessage] = useState("");
  const [askedQuestions, setAskedQuestions] = useState<string[]>([]);
  const isEndingRef = useRef(false);
  const hasClosedRef = useRef(false);

  const activeQuestion = askedQuestions.at(-1) ?? "";

  // Close when the agent leaves the room.
  useEffect(() => {
    const handleParticipantDisconnected = (participant: {
      kind: ParticipantKind;
    }) => {
      if (participant.kind !== ParticipantKind.AGENT) return;
      if (hasClosedRef.current) return;
      hasClosedRef.current = true;
      onClose();
    };
    session.room.on(
      RoomEvent.ParticipantDisconnected,
      handleParticipantDisconnected,
    );
    return () => {
      session.room.off(
        RoomEvent.ParticipantDisconnected,
        handleParticipantDisconnected,
      );
    };
  }, [session.room, onClose]);

  // The agent publishes a `diagnostic_question_started` event right before it
  // asks each provided question (mark_question_started tool).
  useEffect(() => {
    const handleData = (payload: Uint8Array) => {
      try {
        const event = JSON.parse(new TextDecoder().decode(payload));
        if (event?.type === "diagnostic_question_started") {
          const text = event?.metadata?.question?.text;
          if (typeof text === "string" && text.trim()) {
            console.info("[interview] question_started:", text);
            setAskedQuestions((prev) =>
              prev.at(-1) === text ? prev : [...prev, text],
            );
          }
        }
      } catch {
        // ignore non-JSON / unrelated data messages
      }
    };
    session.room.on(RoomEvent.DataReceived, handleData);
    return () => {
      session.room.off(RoomEvent.DataReceived, handleData);
    };
  }, [session.room]);

  useEffect(() => {
    const agentMessages = messages.filter(
      (msg) =>
        msg.from?.kind === ParticipantKind.AGENT || msg.from?.isLocal === false,
    );
    const last = agentMessages.at(-1);
    if (last?.message) setLatestMessage(last.message);
  }, [messages]);

  async function endSession() {
    if (isEndingRef.current) return;
    isEndingRef.current = true;
    hasClosedRef.current = true;
    await localParticipant?.setMicrophoneEnabled(false).catch(() => {});
    await session.end().catch(() => {});
    onClose();
  }

  function toggleMic() {
    void localParticipant?.setMicrophoneEnabled(!isMicrophoneEnabled);
  }

  const state = agent.state ?? "connecting";
  const isConnecting = state === "connecting" || state === "initializing";
  const isSpeaking = state === "speaking";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-50">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white/70 px-6 py-4 backdrop-blur">
        <div>
          {jobTitle && (
            <p className="text-md font-bold tracking-tight text-slate-900">
              {jobTitle}
            </p>
          )}
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-indigo-500">
            {roundTitle}
          </p>
        </div>
        <SessionTimer />
      </header>

      {/* Stage */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-6">
        <div className="relative flex h-40 w-40 items-center justify-center">
          <span
            aria-hidden
            className={
              "absolute inset-0 rounded-full bg-indigo-100 " +
              (isSpeaking ? "animate-ping" : "")
            }
          />
          <span
            className={
              "relative flex h-28 w-28 items-center justify-center rounded-full bg-indigo-600 text-white transition-transform duration-300 " +
              (isSpeaking ? "scale-105" : "scale-100")
            }
          >
            {isConnecting ? (
              <Loader2 size={28} className="animate-spin" />
            ) : (
              <Mic size={28} />
            )}
          </span>
        </div>

        <div className="text-center">
          <p className="text-xl font-bold tracking-tight text-slate-900">
            Sara
          </p>
          <p className="mt-1 text-xs font-bold uppercase tracking-[0.18em] text-slate-400">
            {STATE_LABEL[state] ?? "Interviewer"}
          </p>
        </div>

        {activeQuestion && !isConnecting && (
          <div className="max-w-xl rounded-xl border border-slate-200 bg-white p-5 text-center">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-indigo-500">
              Question {askedQuestions.length}
            </p>
            <p className="mt-2 text-base leading-[1.6] text-slate-900">
              {activeQuestion}
            </p>
          </div>
        )}

        {latestMessage && !isConnecting && (
          <p className="max-w-lg text-center text-md leading-[1.6] text-slate-500">
            {latestMessage}
          </p>
        )}
      </div>

      {/* Controls */}
      <footer className="flex shrink-0 items-center justify-center gap-3 border-t border-slate-200 bg-white px-6 py-6">
        <Button
          variant="outline"
          onClick={toggleMic}
          className={
            "rounded-lg px-5 text-sm font-bold uppercase tracking-[0.18em] transition-colors " +
            (isMicrophoneEnabled
              ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              : "border-slate-300 bg-slate-100 text-slate-500 hover:bg-slate-200")
          }
        >
          {isMicrophoneEnabled ? <Mic size={15} /> : <MicOff size={15} />}
          {isMicrophoneEnabled ? "Mute" : "Unmute"}
        </Button>
        <Button
          onClick={endSession}
          className="rounded-lg bg-slate-900 px-5 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-slate-700 active:bg-slate-800"
        >
          <PhoneOff size={15} />
          End interview
        </Button>
      </footer>
    </div>
  );
}

function SessionTimer() {
  const [elapsed, setElapsed] = useState("00:00");
  const startRef = useRef(Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      const diff = Date.now() - startRef.current;
      const mins = Math.floor(diff / 60000)
        .toString()
        .padStart(2, "0");
      const secs = Math.floor((diff % 60000) / 1000)
        .toString()
        .padStart(2, "0");
      setElapsed(`${mins}:${secs}`);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <span className="text-sm tabular-nums tracking-widest text-slate-500">
      {elapsed}
    </span>
  );
}
