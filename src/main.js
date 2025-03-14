import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as dat from 'dat.gui';

// Playback controls using dat.GUI
const playbackControls = {
  restart: function() {
    currentSample = 0;
    spikeIndex = 0;
    // Clear spike dots from the group
    if (spikeGroup.clear) {
      spikeGroup.clear();
    } else {
      while (spikeGroup.children.length > 0) {
        spikeGroup.remove(spikeGroup.children[0]);
      }
    }
  },
  playbackSpeed: 1.0,
};

const gui = new dat.GUI();
gui.add(playbackControls, 'restart').name('Restart Animation');
gui.add(playbackControls, 'playbackSpeed', 1, 10.0).name('Playback Speed');

// Define which neurons to display and assign each a unique color.
const SELECTED_NEURONS = [60, 61];  // Adjust IDs as needed.
const neuronColors = {};
SELECTED_NEURONS.forEach((id, i) => {
  const hue = i * (360 / SELECTED_NEURONS.length);
  const color = new THREE.Color();
  color.setHSL(hue / 360, 1, 0.5);
  neuronColors[id] = color;
});

// Global scene variables.
let scene, camera, renderer, controls;
let markers = [];
let trails = [];
let markerData = []; // Array of 8 markers, each with an array of {x, y, z} for each sample.
let currentSample = 0;
let lastSampleIndex = 0;
const maxTrailLength = 240;

// Spike and rigid-body data.
let frameTimes = [];
let spikeTimes = [];
let spikeNeurons = [];
let rbposData = [];
let spikeIndex = 0;
let spikeGroup;

// --- Helper: Add Camera Icons ---
function addCameraIcons() {
  const numCams = 6;
  const ringRadius = 1.0;
  const camHeight = 1.0;
  const camGroup = new THREE.Group();
  const camScale = 0.5;

  for (let i = 0; i < numCams; i++) {
    const angle = i * (2 * Math.PI / numCams);
    const x = ringRadius * Math.cos(angle);
    const z = ringRadius * Math.sin(angle);
    const camIcon = new THREE.Group();

    // Camera body
    const bodyGeom = new THREE.BoxGeometry(0.2 * camScale, 0.15 * camScale, 0.1 * camScale);
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0xff5555, wireframe: true });
    camIcon.add(new THREE.Mesh(bodyGeom, bodyMat));

    // Camera lens
    const lensGeom = new THREE.ConeGeometry(0.1 * camScale, 0.1 * camScale, 20);
    const lensMat = new THREE.MeshBasicMaterial({ color: 0xff5555, wireframe: true });
    const lensMesh = new THREE.Mesh(lensGeom, lensMat);
    lensMesh.position.set(0, 0, 0.08 * camScale);
    lensMesh.rotation.x = Math.PI * 3 / 2;
    camIcon.add(lensMesh);

    camIcon.position.set(x, camHeight, z);
    camIcon.lookAt(new THREE.Vector3(0, 0, 0));
    camGroup.add(camIcon);
  }
  scene.add(camGroup);
}

// --- Initialization ---
function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0.3, 1.2, 1.5);

  renderer = new THREE.WebGLRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.body.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // Add floor plane.
  const planeGeo = new THREE.PlaneGeometry(1.5, 1.5, 10, 10);
  const planeMat = new THREE.MeshBasicMaterial({ color: 0x555555, wireframe: true });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.rotation.x = -Math.PI / 2;
  scene.add(plane);

  addCameraIcons();

  // Create spike group.
  spikeGroup = new THREE.Group();
  scene.add(spikeGroup);

  // --- Load Marker Data ---
  Promise.all([
    fetch('./markers8_x.bin').then(r => r.arrayBuffer()).then(buffer => new Float32Array(buffer)),
    fetch('./markers8_y.bin').then(r => r.arrayBuffer()).then(buffer => new Float32Array(buffer)),
    fetch('./markers8_z.bin').then(r => r.arrayBuffer()).then(buffer => new Float32Array(buffer))
  ]).then(([xData, yData, zData]) => {
    const markersCount = 8;
    const samples = xData.length / markersCount;

    for (let i = 0; i < markersCount; i++) {
      markerData[i] = [];
      for (let j = 0; j < samples; j++) {
        const idx = j * markersCount + i;
        markerData[i].push({ x: xData[idx], y: yData[idx], z: zData[idx] });
      }
    }

    // Create marker spheres and trails.
    for (let i = 0; i < markersCount; i++) {
      const color = (i < 3) ? 0xffffff : 0x00ff00;
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.01, 16, 16),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 })
      );
      scene.add(sphere);
      markers.push(sphere);

      const trailGeo = new THREE.BufferGeometry();
      const positions = new Float32Array(maxTrailLength * 3);
      trailGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const progressArray = new Float32Array(maxTrailLength).fill(0);
      trailGeo.setAttribute('progress', new THREE.BufferAttribute(progressArray, 1));

      const trailMat = new THREE.ShaderMaterial({
        uniforms: { baseColor: { value: new THREE.Color(color) } },
        vertexShader: `
          attribute float progress;
          varying float vProgress;
          void main() {
            vProgress = progress;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 baseColor;
          varying float vProgress;
          void main() {
            float brightness = smoothstep(0.0, 1.0, vProgress);
            gl_FragColor = vec4(baseColor * brightness, brightness);
          }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: false
      });

      const trailLine = new THREE.Line(trailGeo, trailMat);
      scene.add(trailLine);

      trails.push({ line: trailLine, positions, progress: progressArray, count: 0 });
    }
  });

  // --- Load Spike and Rigid Body Data ---
  Promise.all([
    fetch('./frame_times.bin').then(r => r.arrayBuffer()).then(buffer => new Float32Array(buffer)),
    fetch('./spike_times.bin').then(r => r.arrayBuffer()).then(buffer => new Float32Array(buffer)),
    fetch('./spike_neurons.bin').then(r => r.arrayBuffer()).then(buffer => new Uint16Array(buffer)),
    fetch('./rbpos.bin').then(r => r.arrayBuffer()).then(buffer => new Float32Array(buffer))
  ]).then(([ftData, stData, snData, rbDataRaw]) => {
    frameTimes = ftData;
    spikeTimes = stData;
    spikeNeurons = snData;
    const sampleCount = rbDataRaw.length / 3;
    rbposData = [];
    for (let i = 0; i < sampleCount; i++) {
      rbposData.push({
        x: rbDataRaw[i * 3],
        y: rbDataRaw[i * 3 + 1],
        z: rbDataRaw[i * 3 + 2]
      });
    }
  });

  window.addEventListener('resize', onWindowResize, false);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Helper: Update Markers and Trails ---
function updateMarkersAndTrails() {
  markers.forEach((marker, i) => {
    const data = markerData[i];
    const sampleIndex = Math.floor(currentSample) % data.length;
    const pos = data[sampleIndex];
    marker.position.set(pos.x, pos.y, pos.z);

    const trail = trails[i];
    const posArray = trail.positions;
    const progArray = trail.progress;
    const stride = 3;
    if (trail.count === 0) {
      posArray[0] = pos.x;
      posArray[1] = pos.y;
      posArray[2] = pos.z;
      trail.count = 1;
    } else {
      for (let j = 0; j < (trail.count - 1) * stride; j++) {
        posArray[j] = posArray[j + stride];
      }
      const baseIndex = (trail.count - 1) * stride;
      posArray[baseIndex] = pos.x;
      posArray[baseIndex + 1] = pos.y;
      posArray[baseIndex + 2] = pos.z;
      if (trail.count < maxTrailLength) {
        trail.count++;
      }
    }
    for (let j = 0; j < trail.count; j++) {
      progArray[j] = (trail.count > 1) ? (j / (trail.count - 1)) : 1;
    }
    trail.line.geometry.setDrawRange(0, trail.count);
    trail.line.geometry.attributes.position.needsUpdate = true;
    trail.line.geometry.attributes.progress.needsUpdate = true;
  });

  // Increment currentSample with playback speed.
  currentSample += Math.round(playbackControls.playbackSpeed);

  // --- Loop Detection and Reset ---
  const currentFrameIndex = Math.floor(currentSample) % markerData[0].length;
  if (currentFrameIndex < lastSampleIndex) {
    // Reset when looping.
    if (spikeGroup.clear) {
      spikeGroup.clear();
    } else {
      while (spikeGroup.children.length > 0) {
        spikeGroup.remove(spikeGroup.children[0]);
      }
    }
    spikeIndex = 0;
    currentSample = 0;
  }
  lastSampleIndex = currentFrameIndex;
}

// --- Helper: Update Spike Dots ---
function updateSpikes() {
  const currentFrameTime = frameTimes[Math.floor(currentSample)] || 0;
  while (spikeIndex < spikeTimes.length && spikeTimes[spikeIndex] <= currentFrameTime) {
    const neuronId = spikeNeurons[spikeIndex];
    if (SELECTED_NEURONS.includes(neuronId)) {
      const rbPos = rbposData[Math.floor(currentSample)] || { x: 0, y: 0, z: 0 };
      const spikeDot = new THREE.Mesh(
        new THREE.SphereGeometry(0.008, 8, 8),
        new THREE.MeshBasicMaterial({ color: neuronColors[neuronId] })
      );
      spikeDot.position.set(rbPos.x, 0.005, rbPos.z);
      spikeGroup.add(spikeDot);
    }
    spikeIndex++;
  }
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();

  if (markerData.length > 0) {
    updateMarkersAndTrails();
  }

  if (frameTimes.length > 0 && spikeTimes.length > 0 && rbposData.length > 0) {
    updateSpikes();
  }

  renderer.render(scene, camera);
}

init();
animate();