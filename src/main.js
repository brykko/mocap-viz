import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as dat from 'dat.gui';

// Playback controls via dat.GUI.
const playbackControls = {
  restart: function() {
    currentSample = 0;
    spikeIndex = 0;
    // Clear spike dots.
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

// Define selected neurons and assign colors.
const SELECTED_NEURONS = [60, 61];
const neuronColors = {};
SELECTED_NEURONS.forEach((id, i) => {
  const hue = i * (360 / SELECTED_NEURONS.length);
  const color = new THREE.Color();
  color.setHSL(hue / 360, 1, 0.5);
  neuronColors[id] = color;
});

// Global scene variables.
let scene, camera, renderer, controls;
let markers = [];      // Spheres for each marker.
let markerData = [];   // 8 arrays, one per marker.
let currentSample = 0;
let lastSampleIndex = 0;
const maxTrailLength = 240;

// Spike and rigid-body data.
let frameTimes = [];
let spikeTimes = [];
let spikeNeurons = [];
let rbposData = [];
let spikeIndex = 0;
let spikeGroup;  // Group to hold spike dots.

// New objects for the rigid-body.
let rbSphere;    // The orange sphere.
let rbTrail;     // The trail for the rigid-body.
let rbTrailCount = 0;  // Number of points in the rigid-body trail.
let rbTrailPositions;  // Float32Array for rbTrail geometry.

// Connection lines for markers.
let backLine1, backLine2;       // Lines connecting back markers (markers[0-2]).
let rbConnLines;                // LineSegments connecting every pair among rigid-body markers (markers[3-7]).

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
    // Camera body.
    const bodyGeom = new THREE.BoxGeometry(0.2 * camScale, 0.15 * camScale, 0.1 * camScale);
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0xff5555, wireframe: true });
    camIcon.add(new THREE.Mesh(bodyGeom, bodyMat));
    // Camera lens.
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

// --- Initialize Scene ---
function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
  camera.position.set(0.3, 1.2, 1.5);

  renderer = new THREE.WebGLRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.body.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // Add floor.
  const planeGeo = new THREE.PlaneGeometry(1.5, 1.5, 10, 10);
  const planeMat = new THREE.MeshBasicMaterial({ color: 0x555555, wireframe: true });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.rotation.x = -Math.PI/2;
  scene.add(plane);

  addCameraIcons();

  // Group for spike dots.
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
    // Create marker spheres.
    for (let i = 0; i < markersCount; i++) {
      const color = (i < 3) ? 0xffffff : 0x00ff00;
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.01, 16, 16),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 })
      );
      scene.add(sphere);
      markers.push(sphere);
    }
    // Create connection lines for markers.
    createConnectionLines();
  });

  // --- Load Spike and Rigid-Body Data ---
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
        x: rbDataRaw[i*3],
        y: rbDataRaw[i*3+1],
        z: rbDataRaw[i*3+2]
      });
    }
    // Create rigid-body sphere (orange).
    rbSphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.015, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffa500 }) // orange
    );
    scene.add(rbSphere);
    // Create rigid-body trail.
    rbTrailPositions = new Float32Array(maxTrailLength * 3);
    const rbTrailGeo = new THREE.BufferGeometry();
    rbTrailGeo.setAttribute('position', new THREE.BufferAttribute(rbTrailPositions, 3));
    const rbTrailMat = new THREE.LineBasicMaterial({ color: 0xffa500 });
    rbTrail = new THREE.Line(rbTrailGeo, rbTrailMat);
    scene.add(rbTrail);
  });

  window.addEventListener('resize', onWindowResize, false);
}

function createConnectionLines() {
  // Create back marker connections (markers[0] to markers[1] and markers[1] to markers[2]).
  const backGeom1 = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  backLine1 = new THREE.Line(backGeom1, new THREE.LineBasicMaterial({ color: 0xffffff }));
  scene.add(backLine1);

  const backGeom2 = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  backLine2 = new THREE.Line(backGeom2, new THREE.LineBasicMaterial({ color: 0xffffff }));
  scene.add(backLine2);

  // Create rigid-body connections among markers[3] to markers[7] (complete graph).
  // There are 5 markers, so 5 choose 2 = 10 segments, i.e. 20 vertices.
  const numRbMarkers = 5;
  const numSegments = (numRbMarkers * (numRbMarkers - 1)) / 2;
  const rbConnPositions = new Float32Array(numSegments * 2 * 3);
  const rbConnGeom = new THREE.BufferGeometry();
  rbConnGeom.setAttribute('position', new THREE.BufferAttribute(rbConnPositions, 3));
  rbConnLines = new THREE.LineSegments(rbConnGeom, new THREE.LineBasicMaterial({ color: 0xffffff }));
  scene.add(rbConnLines);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Update Markers and Connection Lines ---
function updateMarkersAndConnections() {
  // Update marker positions from markerData.
  markers.forEach((marker, i) => {
    const data = markerData[i];
    const sampleIndex = Math.floor(currentSample) % data.length;
    const pos = data[sampleIndex];
    marker.position.set(pos.x, pos.y, pos.z);
  });

  // Update back connections.
  if (markers.length >= 3) {
    // Back marker line from markers[0] to markers[1]
    backLine1.geometry.attributes.position.setXYZ(0, markers[0].position.x, markers[0].position.y, markers[0].position.z);
    backLine1.geometry.attributes.position.setXYZ(1, markers[1].position.x, markers[1].position.y, markers[1].position.z);
    backLine1.geometry.attributes.position.needsUpdate = true;
    // Back marker line from markers[1] to markers[2]
    backLine2.geometry.attributes.position.setXYZ(0, markers[1].position.x, markers[1].position.y, markers[1].position.z);
    backLine2.geometry.attributes.position.setXYZ(1, markers[2].position.x, markers[2].position.y, markers[2].position.z);
    backLine2.geometry.attributes.position.needsUpdate = true;
  }

  // Update rigid-body connections (markers[3] to markers[7]).
  if (markers.length >= 8) {
    const positions = rbConnLines.geometry.attributes.position.array;
    let idx = 0;
    // For markers indices 3,4,5,6,7.
    for (let i = 3; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        positions[idx++] = markers[i].position.x;
        positions[idx++] = markers[i].position.y;
        positions[idx++] = markers[i].position.z;
        positions[idx++] = markers[j].position.x;
        positions[idx++] = markers[j].position.y;
        positions[idx++] = markers[j].position.z;
      }
    }
    rbConnLines.geometry.attributes.position.needsUpdate = true;
  }
}

// --- Update Rigid-Body Sphere and Trail ---
function updateRigidBody() {
  if (rbposData.length === 0) return;
  const rbIndex = Math.floor(currentSample) % rbposData.length;
  const rbPos = rbposData[rbIndex];
  rbSphere.position.set(rbPos.x, rbPos.y, rbPos.z);

  // Update the rigid-body trail:
  // Shift existing positions.
  for (let i = 0; i < (rbTrailCount - 1) * 3; i++) {
    rbTrailPositions[i] = rbTrailPositions[i + 3];
  }
  // Append the current rbPos.
  const base = (rbTrailCount - 1) * 3;
  rbTrailPositions[base] = rbPos.x;
  rbTrailPositions[base + 1] = rbPos.y;
  rbTrailPositions[base + 2] = rbPos.z;
  if (rbTrailCount < maxTrailLength) {
    rbTrailCount++;
  }
  rbTrail.geometry.setDrawRange(0, rbTrailCount);
  rbTrail.geometry.attributes.position.needsUpdate = true;
}

// --- Update Spike Dots ---
function updateSpikes() {
  const currentFrameTime = frameTimes[Math.floor(currentSample)] || 0;
  while (spikeIndex < spikeTimes.length && spikeTimes[spikeIndex] <= currentFrameTime) {
    const neuronId = spikeNeurons[spikeIndex];
    if (SELECTED_NEURONS.includes(neuronId)) {
      const rbIndex = Math.floor(currentSample) % rbposData.length;
      const rbPos = rbposData[rbIndex] || { x: 0, y: 0, z: 0 };
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
    updateMarkersAndConnections();
    currentSample += Math.round(playbackControls.playbackSpeed);
    // Loop detection.
    const currentFrameIndex = Math.floor(currentSample) % markerData[0].length;
    if (currentFrameIndex < lastSampleIndex) {
      // When looping, clear spike dots and reset indices.
      if (spikeGroup.clear) {
        spikeGroup.clear();
      } else {
        while (spikeGroup.children.length > 0) {
          spikeGroup.remove(spikeGroup.children[0]);
        }
      }
      spikeIndex = 0;
      currentSample = 0;
      rbTrailCount = 0;
    }
    lastSampleIndex = currentFrameIndex;
  }

  if (frameTimes.length > 0 && spikeTimes.length > 0 && rbposData.length > 0) {
    updateSpikes();
    updateRigidBody();
  }

  renderer.render(scene, camera);
}

init();
animate();