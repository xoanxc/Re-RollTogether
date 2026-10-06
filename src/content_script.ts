import _ from "lodash";

import { LIMIT_DELTA_TIME, log, getEnumKeys } from "./common";

import {
  States,
  Actions,
  PlayerStateProp,
  MessageTypes,
  Message,
  PortName,
} from "./types";
import { extensionAPI } from "./browser-compat";

const g_port = extensionAPI.runtime.connect({ name: PortName.CONTENT_SCRIPT });

let g_actionLockExpires = 0;

function setLock(ms: number) {
  g_actionLockExpires = Date.now() + ms;
}

function isLocked(): boolean {
  return Date.now() < g_actionLockExpires;
}

let g_player: HTMLVideoElement | undefined = undefined;
let g_lastFrameProgress: number | undefined = undefined;
let g_heartBeatInterval: NodeJS.Timeout | undefined = undefined; // Keeps Service Worker alive while connected
let g_pendingMessages: Message[] = [];
let g_playPromise: Promise<void> | undefined = undefined;
let g_remoteUpdateAbortController: AbortController | undefined = undefined;

function getState(stateName: PlayerStateProp): boolean | number {
  return g_player![stateName];
}

function getStates(): {
  state: States;
  currentProgress: number;
  timeJump: boolean;
} {
  const [paused, currentProgress]: [boolean, number] = [
    getState("paused") as boolean,
    getState("currentTime") as number,
  ];

  g_lastFrameProgress = g_lastFrameProgress || currentProgress;

  const timeJump: boolean =
    Math.abs(currentProgress - g_lastFrameProgress) > LIMIT_DELTA_TIME;
  const state: States = paused ? States.PAUSED : States.PLAYING;

  g_lastFrameProgress = currentProgress;
  return { state, currentProgress, timeJump };
}

// 1. Declaramos la función con debounce utilizando lodash
// Esto agrupa las llamadas repetitivas en un periodo de 400ms.
const debouncedSync = _.debounce((state: States, currentProgress: number) => {
  const type = MessageTypes.CS2SW_LOCAL_UPDATE;
  g_port.postMessage({ type, state, currentProgress });
}, 400);

const handleLocalAction = (action: Actions) => (): void => {
  if (isLocked()) {
    return;
  }

  const { state, currentProgress, timeJump }: { state: States; currentProgress: number; timeJump: boolean } = getStates();

  switch (action) {
    case Actions.PLAY:
    case Actions.PAUSE:
      // Si hay un play o pause explícito, forzamos el envío cancelando esperas previas
      debouncedSync.flush(); 
      g_port.postMessage({ type: MessageTypes.CS2SW_LOCAL_UPDATE, state, currentProgress });
      break;
    case Actions.TIME_UPDATE:
      if (timeJump) {
        // En lugar de enviar un postMessage inmediato cada milisegundo al arrastrar,
        // usamos el debounce. Solo se enviará cuando el usuario deje de arrastrar.
        debouncedSync(state, currentProgress);
      }
      break;
  }
};

function sendRoomConnectionMessage(): void {
  const { state, currentProgress }: { state: States; currentProgress: number } =
    getStates();
  const type = MessageTypes.CS2SW_ROOM_CONNECTION;
  g_port.postMessage({ state, currentProgress, type });
}

async function handleRemoteUpdate(message: Message): Promise<void> {
  if (message.type != MessageTypes.SW2CS_REMOTE_UPDATE) {
    throw "Invalid Message Type: " + message.type;
  }
  const { roomState, roomProgress } = message;
  log("Handling Remote Update", { roomState, roomProgress });

  if (_.isNil(g_player)) {
    log("Player is Undefined so no remote action will be triggered");
    return;
  }

  // Cancel any pending remote updates
  if (g_remoteUpdateAbortController) {
    g_remoteUpdateAbortController.abort();
  }
  g_remoteUpdateAbortController = new AbortController();
  const signal = g_remoteUpdateAbortController.signal;

  const { state, currentProgress }: { state: States; currentProgress: number } = getStates();

  // 1. Decouple Time Updates from Play/Pause Executions
  if (Math.abs(roomProgress - currentProgress) > LIMIT_DELTA_TIME) {
    setLock(5000); // Lock local action emission during seek
    g_player.currentTime = roomProgress;

    // Await seeked event with fallback
    await new Promise<void>((resolve) => {
      let timeoutId: NodeJS.Timeout;

      const onSeeked = () => {
        clearTimeout(timeoutId);
        resolve();
      };

      const onAbort = () => {
        g_player!.removeEventListener("seeked", onSeeked);
        clearTimeout(timeoutId);
        resolve();
      };

      timeoutId = setTimeout(() => {
        log("Seeked event fallback timeout triggered");
        g_player!.removeEventListener("seeked", onSeeked);
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, 3000);

      g_player!.addEventListener("seeked", onSeeked, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  if (signal.aborted) {
    log("Remote update execution aborted");
    return;
  }

  // 2. Handle state application and handle/catch pending play() Promises
  setLock(1000);
  if (roomState === States.PAUSED) {
    g_player.pause();
  } else if (roomState === States.PLAYING) {
    const attemptPlaySafe = () => {
      setLock(1000); // Re-lock just before play
      g_playPromise = g_player!.play();
      if (g_playPromise !== undefined) {
        g_playPromise.catch(error => {
          log("Promesa de play() rechazada, posible interrupción", error);
        });
      }
    };

    if (g_player.readyState >= 3) {
      attemptPlaySafe();
    } else {
      await new Promise<void>((resolve) => {
        let timeoutId: NodeJS.Timeout;

        const onCanPlay = () => {
          clearTimeout(timeoutId);
          resolve();
        };

        const onAbort = () => {
          g_player!.removeEventListener("canplay", onCanPlay);
          clearTimeout(timeoutId);
          resolve();
        };

        timeoutId = setTimeout(() => {
          log("canplay event fallback timeout triggered (buffer lag)");
          g_player!.removeEventListener("canplay", onCanPlay);
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, 5000);

        g_player!.addEventListener("canplay", onCanPlay, { once: true });
        signal.addEventListener("abort", onAbort, { once: true });
      });

      if (!signal.aborted) {
        attemptPlaySafe();
      }
    }
  }
}

function handleServiceWorkerMessage(serviceWorkerMessage: Message) {
  if (!g_player) {
    log("Player not ready, queuing message", serviceWorkerMessage);
    g_pendingMessages.push(serviceWorkerMessage);
    return;
  }

  log("Received message from Background", serviceWorkerMessage);

  switch (serviceWorkerMessage.type) {
    case MessageTypes.SW2CS_ROOM_CONNECTION:
      g_heartBeatInterval = setInterval(
        () => g_port.postMessage({ type: MessageTypes.CS2SW_HEART_BEAT }),
        20000
      );
      sendRoomConnectionMessage();
      break;
    case MessageTypes.SW2CS_REMOTE_UPDATE:
      handleRemoteUpdate(serviceWorkerMessage);
      break;
  }
}

// 1. Escuchar los mensajes del Service Worker
g_port.onMessage.addListener(handleServiceWorkerMessage);

// 2. Selector exacto de Bitmovin
const getCrunchyrollVideo = (): HTMLVideoElement | undefined => {
  const video = document.querySelector<HTMLVideoElement>('video#bitmovinplayer-video-null, .bitmovinplayer-container video, video');
  return video !== null ? video : undefined;
};

// 3. Bucle de inicialización del reproductor
const initializePlayer = () => {
  const video = getCrunchyrollVideo();

  if (_.isNil(video)) {
    setTimeout(initializePlayer, 1000); // Reintenta hasta que el vídeo aparezca en el DOM
    return;
  }

  log("[Re-RollTogether] Reproductor detectado con éxito:", video);
  g_player = video;

  // Asigna automáticamente los eventos (play, pause, timeupdate) al vídeo
  getEnumKeys(Actions).forEach((key) => {
    const action = Actions[key];
    g_player!.addEventListener(action, handleLocalAction(action));
  });

  // Procesa cualquier mensaje que haya llegado mientras el vídeo cargaba
  while (g_pendingMessages.length > 0) {
    const msg = g_pendingMessages.shift();
    if (msg) handleServiceWorkerMessage(msg);
  }
};

// Arrancar cuando la página cargue
if (document.readyState === "complete") {
  setTimeout(initializePlayer, 2000);
} else {
  window.addEventListener("load", () => {
    setTimeout(initializePlayer, 2000);
  });
}
