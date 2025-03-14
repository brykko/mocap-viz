import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as dat from 'dat.gui';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';

// Playback controls via dat.GUI.
const playbackControls = {
  restart: function() {
    currentSample = 0;
    spikeIndex = 0;
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

const DITHER_AMOUNT = 0.05;
const SHOW_FOV_CONES = true;

const gui = new dat.GUI();
gui.add(playbackControls, 'restart').name('Restart Animation');
gui.add(playbackControls, 'playbackSpeed', 1, 10.0).name('Playback Speed');

// Define which neurons to display and assign colors.
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
let markers = [];           // Spheres for each marker.
let markerData = [];        // 8 arrays, one per marker.
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

// Rigid-body objects.
let rbSphere;               // The orange sphere.
let rbTrail;                // Rigid-body trail using fat line.
let rbTrailPositions;       // Flat array of numbers.
let rbTrailCount = 0;

// Connection lines.
let backLine1, backLine2;   // Fat lines for back marker connections.
let rbConnLines;            // Fat line segments for rigid-body marker connections.

// ----- New: Create a FOV cone with graded (inverse-square) falloff -----
function createFOVCone(fov, height) {
  // Compute the base radius of the cone.
  const radius = height * Math.tan(THREE.MathUtils.degToRad(fov / 2));
  
  // Create a cone geometry. Set openEnded to true so it has no cap.
  const geometry = new THREE.ConeGeometry(radius, height, 32, 1, true);
  // Translate so that the tip is at the origin.
  geometry.translate(0, -height / 2, 0);
  
  // Create a custom shader material that fades according to the inverse-square law.
  const material = new THREE.ShaderMaterial({
    uniforms: {
      diffuse: { value: new THREE.Color(0xffffff) },
      opacity: { value: 0.1 },
      falloffScale: { value: 20}
    },
    vertexShader: `
      varying float vDist;
      void main() {
        // Assuming the cone is oriented along negative Y,
        // use the absolute y-coordinate as distance.
        vDist = abs(position.y);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 diffuse;
      uniform float opacity;
      uniform float falloffScale;
      varying float vDist;
      void main() {
        float intensity;
        float minDist = 0.03;
        float d = vDist;
        if (d > minDist) {
          // Inverse-square falloff.
          intensity = 1.0 / (d * d * falloffScale);
          intensity = clamp(intensity, 0.0, 1.0);
        } else {
          intensity = 0.0; 
        }
        gl_FragColor = vec4(diffuse, opacity * intensity);
      }
    `,
    transparent: true,  
    depthWrite: false,
    side: THREE.DoubleSide
  });
  
  return new THREE.Mesh(geometry, material);
}

// function createFOVCone(fov, height) {
//   // Compute base radius.
//   const radius = height * Math.tan(THREE.MathUtils.degToRad(fov / 2));
  
//   // Create a cone geometry.
//   // The 'openEnded' flag is set to true so there's no cap on the cone.
//   const geometry = new THREE.ConeGeometry(radius, height, 32, 1, true);
  
//   // Move the geometry so that the tip is at the origin.
//   geometry.translate(0, -height / 2, 0);
  
//   // Create a material that fades toward the tip.
//   // Optionally you could create a custom ShaderMaterial for a smoother gradient.
//   const material = new THREE.MeshBasicMaterial({
//     color: 0xffffaa,
//     transparent: true,
//     opacity: 0.2,
//     side: THREE.DoubleSide,
//     depthWrite: false
//   });
  
//   return new THREE.Mesh(geometry, material);
// }

// --- Add Camera Icons (unchanged) ---
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
    const bodyGeom = new THREE.BoxGeometry(0.2 * camScale, 0.15 * camScale, 0.1 * camScale);
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.5 });
    camIcon.add(new THREE.Mesh(bodyGeom, bodyMat));
    const lensGeom = new THREE.ConeGeometry(0.1 * camScale, 0.1 * camScale, 20);
    const lensMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.5 });
    const lensMesh = new THREE.Mesh(lensGeom, lensMat);
    lensMesh.position.set(0, 0, 0.08 * camScale);
    lensMesh.rotation.x = Math.PI * 3 / 2;
    camIcon.add(lensMesh);
    camIcon.position.set(x, camHeight, z);
    camIcon.lookAt(new THREE.Vector3(0, 0, 0));

    // Add the light cone effect
    // Example: Add a FOV cone to a camera icon.
    if (SHOW_FOV_CONES) {
        const cameraFOV = 60;  // Field of view in degrees.
        const coneHeight = 1.0;  // Desired length of the cone.
        const fovCone = createFOVCone(cameraFOV, coneHeight);
    
        // Position the cone so that its tip is at the camera's location.
        // For example, if your camera icon faces -Z, you might rotate the cone:
        fovCone.rotation.x = Math.PI * 3 / 2;  // Flip it so the cone points forward.
        fovCone.position.set(0, 0, 0);  // Adjust as needed.
        camIcon.add(fovCone);
    }

    camGroup.add(camIcon);
  }
  scene.add(camGroup);
}

// --- Initialize Scene ---
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
  const planeGeo = new THREE.PlaneGeometry(1.5, 1.5, 10, 10);
  const planeMat = new THREE.MeshBasicMaterial({ color: 0x555555, wireframe: true });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.rotation.x = -Math.PI / 2;
  scene.add(plane);
  addCameraIcons();
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
      const color = (i < 3) ? 0x00ff00 : 0x00ff00;
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.01, 16, 16),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 })
      );
      scene.add(sphere);
      markers.push(sphere);
    }
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
        x: rbDataRaw[i * 3],
        y: rbDataRaw[i * 3 + 1],
        z: rbDataRaw[i * 3 + 2]
      });
    }
    // Create rigid-body sphere (orange).
    rbSphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.015, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffa500 })
    );
    scene.add(rbSphere);
    // Create rigid-body trail as a fat line.
    rbTrailPositions = new Array(maxTrailLength * 3).fill(0);
    const rbTrailGeom = new LineGeometry();
    rbTrailGeom.setPositions(rbTrailPositions);
    const rbTrailMat = new LineMaterial({
      color: 0xffffff,
      linewidth: 2,
      resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
      transparent: true,
      opacity: 0.2
    });
    rbTrail = new Line2(rbTrailGeom, rbTrailMat);
    rbTrail.computeLineDistances();
    scene.add(rbTrail);
  });

  window.addEventListener('resize', onWindowResize, false);
}

function createConnectionLines() {
  // Back marker connections (markers[0]-[1] and markers[1]-[2]) as fat lines.
  const backPositions1 = [0, 0, 0, 0, 0, 0];
  const backGeom1 = new LineGeometry();
  backGeom1.setPositions(backPositions1);
  const backMat = new LineMaterial({
    color: 0x00ff00,
    linewidth: 2,
    resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
    transparent: true,
  });
  backLine1 = new Line2(backGeom1, backMat);
  backLine1.computeLineDistances();
  scene.add(backLine1);

  const backPositions2 = [0, 0, 0, 0, 0, 0];
  const backGeom2 = new LineGeometry();
  backGeom2.setPositions(backPositions2);
  backLine2 = new Line2(backGeom2, backMat.clone());
  backLine2.computeLineDistances();
  scene.add(backLine2);

  // Rigid-body connections among markers[3]-[7] as fat line segments.
  const numRbMarkers = 5;
  const numSegments = (numRbMarkers * (numRbMarkers - 1)) / 2;
  const rbConnPositions = new Array(numSegments * 2 * 3).fill(0);
  const rbConnGeom = new LineGeometry();
  rbConnGeom.setPositions(rbConnPositions);
  const rbConnMat = new LineMaterial({
    color: 0x00ff00,
    linewidth: 2,
    resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
    transparent: true,
  });
  rbConnLines = new LineSegments2(rbConnGeom, rbConnMat);
  scene.add(rbConnLines);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  const resolution = new THREE.Vector2(window.innerWidth, window.innerHeight);
  if (rbTrail && rbTrail.material && rbTrail.material.resolution) {
    rbTrail.material.resolution.copy(resolution);
  }
  if (backLine1 && backLine1.material && backLine1.material.resolution) {
    backLine1.material.resolution.copy(resolution);
  }
  if (backLine2 && backLine2.material && backLine2.material.resolution) {
    backLine2.material.resolution.copy(resolution);
  }
  if (rbConnLines && rbConnLines.material && rbConnLines.material.resolution) {
    rbConnLines.material.resolution.copy(resolution);
  }
}

// --- Update Markers and Connection Lines ---
function updateMarkersAndConnections() {
  markers.forEach((marker, i) => {
    const data = markerData[i];
    const sampleIndex = Math.floor(currentSample) % data.length;
    const pos = data[sampleIndex];
    marker.position.set(pos.x, pos.y, pos.z);
  });

  // Update back connections.
  if (markers.length >= 3) {
    backLine1.geometry.setPositions([
      markers[0].position.x, markers[0].position.y, markers[0].position.z,
      markers[1].position.x, markers[1].position.y, markers[1].position.z,
    ]);
    backLine2.geometry.setPositions([
      markers[1].position.x, markers[1].position.y, markers[1].position.z,
      markers[2].position.x, markers[2].position.y, markers[2].position.z,
    ]);
  }

  // Update rigid-body connections among markers[3]-[7].
  if (markers.length >= 8) {
    const positions = [];
    for (let i = 3; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        positions.push(
          markers[i].position.x, markers[i].position.y, markers[i].position.z,
          markers[j].position.x, markers[j].position.y, markers[j].position.z
        );
      }
    }
    rbConnLines.geometry.setPositions(positions);
  }
}

function updateRigidBody() {
  if (rbposData.length === 0) return;
  const rbIndex = Math.floor(currentSample) % rbposData.length;
  const rbPos = rbposData[rbIndex];
  rbSphere.position.set(rbPos.x, rbPos.y, rbPos.z);

  // If no points yet in the trail, initialize the first point.
  if (rbTrailCount === 0) {
    rbTrailPositions[0] = rbPos.x;
    rbTrailPositions[1] = rbPos.y;
    rbTrailPositions[2] = rbPos.z;
    rbTrailCount = 1;
  } else {
    // Shift existing positions forward to "age" the trail.
    for (let i = 0; i < (rbTrailCount - 1) * 3; i++) {
      rbTrailPositions[i] = rbTrailPositions[i + 3];
    }
    // Set the last valid point in the trail.
    const base = (rbTrailCount - 1) * 3;
    rbTrailPositions[base] = rbPos.x;
    rbTrailPositions[base + 1] = rbPos.y;
    rbTrailPositions[base + 2] = rbPos.z;
    if (rbTrailCount < maxTrailLength) {
      rbTrailCount++;
    }
  }

  // Pad all unused positions with the current position to avoid jumps to (0,0,0).
  for (let i = rbTrailCount; i < maxTrailLength; i++) {
    const index = i * 3;
    rbTrailPositions[index] = rbPos.x;
    rbTrailPositions[index + 1] = rbPos.y;
    rbTrailPositions[index + 2] = rbPos.z;
  }

  rbTrail.geometry.setPositions(rbTrailPositions);
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

      spikeDot.position.set(
        rbPos.x + (Math.random() - 0.5) * DITHER_AMOUNT,
        0.005 + (Math.random() - 0.5) * DITHER_AMOUNT,
        rbPos.z + (Math.random() - 0.5) * DITHER_AMOUNT
      );

      // spikeDot.position.set(rbPos.x, 0.005, rbPos.z);
      spikeGroup.add(spikeDot);
    }
    spikeIndex++;
  }
}

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  controls.update();

  if (markerData.length > 0) {
    updateMarkersAndConnections();
    // currentSample += Math.round(playbackControls.playbackSpeed);
    const delta = clock.getDelta();
    currentSample += delta * 120 * playbackControls.playbackSpeed;
    const currentFrameIndex = Math.floor(currentSample) % markerData[0].length;
    if (currentFrameIndex < lastSampleIndex) {
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