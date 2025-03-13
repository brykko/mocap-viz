import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// At the top, after your imports:
import * as dat from 'dat.gui';

const playbackControls = {
  restart: function() {
    currentSample = 0;
    spikeIndex = 0;
  },
  playbackSpeed: 1.0, // multiplier for how quickly currentSample advances
  currentFrame: 0, // optional: allows jumping to a specific frame
};

const gui = new dat.GUI();
gui.add(playbackControls, 'restart').name('Restart Animation');
gui.add(playbackControls, 'playbackSpeed', 1, 10.0).name('Playback Speed');
// Optionally, if you want to jump to a specific frame:
// gui.add(playbackControls, 'currentFrame', 0, 1000).name('Current Frame').onFinishChange(value => {
//   currentSample = Math.floor(value);
//   spikeIndex = 0; // reset spikes if needed
// });

// --- New: Define which neurons to display and assign colors ---
const SELECTED_NEURONS = [60, 61];  // Change these IDs as needed
const neuronColors = {};
SELECTED_NEURONS.forEach((id, i) => {
  // For example, assign colors using HSL so that each gets a different hue.
  const hue = i * (360 / SELECTED_NEURONS.length);
  const color = new THREE.Color();
  color.setHSL(hue / 360, 1, 0.5);
  neuronColors[id] = color;
});

// Global variables for scene, camera, etc.
let scene, camera, renderer, controls;
let markers = [];
let trails = [];
let markerData = []; // Array of 8 markers, each with an array of {x, y, z} for each sample
let currentSample = 0;
let lastSampleIndex;
const maxTrailLength = 240; // maximum number of positions in the trail

// New globals for spike data
let frameTimes = [];      // from frame_times.bin
let spikeTimes = [];      // from spike_times.bin
let spikeNeurons = [];    // from spike_neurons.bin
let rbposData = [];       // from rbpos.bin (rigid body positions)
let spikeIndex = 0;       // pointer into spikeTimes
let spikeGroup;           // group to hold spike dots

// --- Camera Icons (existing) ---
function addCameraIcons() {
  const numCams = 6;           // Number of camera icons
  const ringRadius = 1.0;        // Radius of the ring (distance from center)
  const camHeight = 1.0;       // Height above the arena
  const camGroup = new THREE.Group();
  const camScale = 0.5;

  for (let i = 0; i < numCams; i++) {
    const angle = i * (2 * Math.PI / numCams);
    const x = ringRadius * Math.cos(angle);
    const z = ringRadius * Math.sin(angle);
    
    // Create a group for a single camera icon
    const camIcon = new THREE.Group();
    
    // Camera body (wireframe box)
    const bodyGeom = new THREE.BoxGeometry(0.2 * camScale, 0.15 * camScale, 0.1 * camScale);
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0xff5555, wireframe: true });
    const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
    camIcon.add(bodyMesh);
    
    // Camera lens (a small cone)
    const lensGeom = new THREE.ConeGeometry(0.1 * camScale, 0.1 * camScale, 20);
    const lensMat = new THREE.MeshBasicMaterial({ color: 0xff5555, wireframe: true });
    const lensMesh = new THREE.Mesh(lensGeom, lensMat);
    // Position the lens at the "front" of the camera (assuming -Z is forward)
    lensMesh.position.set(0, 0, 0.08 * camScale);
    lensMesh.rotation.x = Math.PI * 3 / 2;
    camIcon.add(lensMesh);
    
    // Position the camera icon in the ring and set its height
    camIcon.position.set(x, camHeight, z);
    
    // Rotate the icon so it faces the center (for a neat effect)
    camIcon.lookAt(new THREE.Vector3(0, 0, 0));
    
    camGroup.add(camIcon);
  }
  scene.add(camGroup);
}

function init() {
  // Create scene and set background to black
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // Set up camera
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0.3, 1.2, 1.5); // slightly elevated for a better view

  // Set up renderer
  renderer = new THREE.WebGLRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.body.appendChild(renderer.domElement);

  // Add OrbitControls for mouse interaction (rotate, zoom, pan)
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; // smoother control

  // Add a horizontal wireframe plane at y = 0
  const planeGeo = new THREE.PlaneGeometry(1.5, 1.5, 10, 10);
  const planeMat = new THREE.MeshBasicMaterial({ color: 0x555555, wireframe: true });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.rotation.x = -Math.PI / 2; // lie horizontally
  scene.add(plane);

  addCameraIcons();

  // Create a group to hold spike dots and add to scene.
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

    // Reshape marker data: create an array for each marker with its sample positions
    for (let i = 0; i < markersCount; i++) {
      markerData[i] = [];
      for (let j = 0; j < samples; j++) {
        const idx = j * markersCount + i;
        markerData[i].push({ x: xData[idx], y: yData[idx], z: zData[idx] });
      }
    }

    // Create marker spheres and their trails
    for (let i = 0; i < markersCount; i++) {
      // Choose color based on marker group (markers 1-3 white, 4-8 green)
      const color = (i < 3) ? 0xffffff : 0x00ff00;

      // Create sphere geometry for the marker
      const sphereGeo = new THREE.SphereGeometry(0.01, 16, 16);
      const sphereMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 });
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      scene.add(sphere);
      markers.push(sphere);

      // Create a dynamic trail using a custom shader material
      const trailGeo = new THREE.BufferGeometry();
      // Pre-allocate positions for the trail (maxTrailLength points)
      const positions = new Float32Array(maxTrailLength * 3);
      trailGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      // Pre-allocate the progress attribute (one float per vertex)
      const progressArray = new Float32Array(maxTrailLength);
      for (let k = 0; k < maxTrailLength; k++) {
        progressArray[k] = 0;
      }
      trailGeo.setAttribute('progress', new THREE.BufferAttribute(progressArray, 1));

      // Custom shader for trail tapering brightness
      const trailMat = new THREE.ShaderMaterial({
        uniforms: {
          baseColor: { value: new THREE.Color(color) }
        },
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

      // Create the trail line object
      const trailLine = new THREE.Line(trailGeo, trailMat);
      scene.add(trailLine);

      // Initialize trail with count 0 (starts empty and grows)
      trails.push({
        line: trailLine,
        positions: positions,
        progress: progressArray,
        count: 0
      });
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
    // Process rbpos.bin into an array of objects (assuming three float32 values per frame)
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

function animate() {
  requestAnimationFrame(animate);
  controls.update();

  // --- Update Marker Positions and Trails ---
  if (markerData.length > 0) {
    markers.forEach((marker, i) => {
      const data = markerData[i];
      const sampleIndex = Math.floor(currentSample) % data.length;
      const pos = data[sampleIndex];
      marker.position.set(pos.x, pos.y, pos.z);

      // Update corresponding trail:
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
        // Shift positions to "age" the trail:
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

      // Update the progress attribute so that the oldest point is 0 and the newest is 1.
      for (let j = 0; j < trail.count; j++) {
        progArray[j] = (trail.count > 1) ? (j / (trail.count - 1)) : 1;
      }

      trail.line.geometry.setDrawRange(0, trail.count);
      trail.line.geometry.attributes.position.needsUpdate = true;
      trail.line.geometry.attributes.progress.needsUpdate = true;
    });

    // Increment currentSample using the playback speed.
    currentSample += Math.round(playbackControls.playbackSpeed);

    // --- Detect Looping ---
    // Compute the current frame index (assuming markerData[0] exists)
    const currentFrameIndex = Math.floor(currentSample) % markerData[0].length;
    if (currentFrameIndex < lastSampleIndex) {
      // The animation has looped: clear spike dots and reset spikeIndex.
      while (spikeGroup.children.length > 0) {
        spikeGroup.remove(spikeGroup.children[0]);
      }
      spikeIndex = 0;
    }
    lastSampleIndex = currentFrameIndex;
  }

  // --- Drop Spike Dots ---
  if (frameTimes.length > 0 && spikeTimes.length > 0 && rbposData.length > 0) {
    const currentFrameTime = frameTimes[Math.floor(currentSample)] || 0;
    // Process all spikes that occur at or before the current frame time.
    while (spikeIndex < spikeTimes.length && spikeTimes[spikeIndex] <= currentFrameTime) {
      const neuronId = spikeNeurons[spikeIndex];
      // Only drop spike dots for selected neurons.
      if (SELECTED_NEURONS.includes(neuronId)) {
        // Use the rigid body position from the current frame.
        const rbPos = rbposData[Math.floor(currentSample)] || { x: 0, y: 0, z: 0 };
        // Create a small sphere as the spike dot, colored according to the neuron.
        const spikeDot = new THREE.Mesh(
          new THREE.SphereGeometry(0.008, 8, 8),
          new THREE.MeshBasicMaterial({ color: neuronColors[neuronId] })
        );
        // Position the spike dot on the floor (with a small y offset).
        spikeDot.position.set(rbPos.x, 0.005, rbPos.z);
        spikeGroup.add(spikeDot);
      }
      spikeIndex++;
    }
  }

  renderer.render(scene, camera);
}

init();
animate();