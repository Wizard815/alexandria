// Owlbear Rodeo loads this page (the manifest's background_url) in every browser of the room while the room is open.
import OBR from '@owlbear-rodeo/sdk';
import { startWorkerOnce } from './sync.ts';

OBR.onReady(() => startWorkerOnce());
