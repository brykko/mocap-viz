import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Global variables
let scene, camera, renderer, controls;
let markers = [];
let trails = [];
let markerData = []; // Array of 8 markers, each with an array of {x, y, z} for each sample
let currentSample = 0;
const maxTrailLength = 240; // maximum number of positions in the trail

  // Add cameras
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
      const bodyGeom = new THREE.BoxGeometry(0.2*camScale, 0.15*camScale, 0.1*camScale);
      const bodyMat = new THREE.MeshBasicMaterial({ color: 0xffff00, wireframe: true });
      const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
      camIcon.add(bodyMesh);
      
      // Camera lens (a small cone)
      const lensGeom = new THREE.ConeGeometry(0.1*camScale, 0.1*camScale, 20);
      const lensMat = new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true });
      const lensMesh = new THREE.Mesh(lensGeom, lensMat);
      // Position the lens at the "front" of the camera (assuming -Z is forward)
      lensMesh.position.set(0, 0, 0.08*camScale);
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
  controls.enableDamping = true; // for smoother control

  // Add a horizontal wireframe plane at y = 0
  const planeGeo = new THREE.PlaneGeometry(1.5, 1.5, 10, 10);
  const planeMat = new THREE.MeshBasicMaterial({ color: 0xadd8e6, wireframe: true,  });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.rotation.x = -Math.PI / 2; // orient to lie horizontally
  scene.add(plane);

  addCameraIcons();


  // Load binary marker data files
  Promise.all([
    fetch('./markers8_x.bin').then(r => r.arrayBuffer()).then(buffer => new Float32Array(buffer)),
    fetch('./markers8_y.bin').then(r => r.arrayBuffer()).then(buffer => new Float32Array(buffer)),
    fetch('./markers8_z.bin').then(r => r.arrayBuffer()).then(buffer => new Float32Array(buffer))
  ]).then(([xData, yData, zData]) => {
    const markersCount = 8;
    const samples = xData.length / markersCount;

    // Reshape binary data: create an array for each marker with its sample positions
    for (let i = 0; i < markersCount; i++) {
      markerData[i] = [];
      for (let j = 0; j < samples; j++) {
        // Use this indexing if data is stored row-major ([markers, samples])
        const idx = j * markersCount + i;
        markerData[i].push({ x: xData[idx], y: yData[idx], z: zData[idx] });
      }
    }

    // Create marker spheres and their trails
    for (let i = 0; i < markersCount; i++) {
      // Decide color based on marker group (markers 1-3 white, 4-8 green)
      const color = (i < 3) ? 0xffffff : 0x00ff00;

      // Create sphere geometry for the marker
      const sphereGeo = new THREE.SphereGeometry(0.01, 16, 16);
      const sphereMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 });
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      scene.add(sphere);
      markers.push(sphere);

      // Create a dynamic line for the trail using a custom shader material
      const trailGeo = new THREE.BufferGeometry();
      // Pre-allocate positions for the trail (maxTrailLength points, each with x,y,z)
      const positions = new Float32Array(maxTrailLength * 3);
      trailGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      // Pre-allocate the progress attribute (one float per vertex)
      const progressArray = new Float32Array(maxTrailLength);
      // Initialize progress values to 0 (they'll be updated as the trail grows)
      for (let k = 0; k < maxTrailLength; k++) {
        progressArray[k] = 0;
      }
      trailGeo.setAttribute('progress', new THREE.BufferAttribute(progressArray, 1));

      // Create a custom shader material for the trail.
      // The vertex shader passes the progress attribute to the fragment shader,
      // and the fragment shader uses it to taper brightness.
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
            // Use smoothstep so that brightness ramps from 0 (oldest) to 1 (newest)
            float brightness = smoothstep(0.0, 1.0, vProgress);
            gl_FragColor = vec4(baseColor * brightness, brightness);
          }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: false
      });

      // Create the trail line object and add it to the scene.
      const trailLine = new THREE.Line(trailGeo, trailMat);
      scene.add(trailLine);

      // Initialize the trail with a count of 0, so it starts empty.
      trails.push({
        line: trailLine,
        positions: positions,
        progress: progressArray,
        count: 0 // start with no points in the trail
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

  // Update OrbitControls (if damping is enabled)
  controls.update();

  // Only update if marker data has been loaded
  if (markerData.length > 0) {
    markers.forEach((marker, i) => {
      const data = markerData[i];
      const sampleIndex = currentSample % data.length;
      const pos = data[sampleIndex];
      marker.position.set(pos.x, pos.y, pos.z);
    
      // Update the corresponding trail:
      const trail = trails[i];
      const posArray = trail.positions;
      const progArray = trail.progress;
      const stride = 3; // x, y, z per point

      if (trail.count === 0) {
        // If the trail is empty, add the first point.
        posArray[0] = pos.x;
        posArray[1] = pos.y;
        posArray[2] = pos.z;
        trail.count = 1;
      } else {
        // Shift positions to "age" the trail.
        for (let j = 0; j < (trail.count - 1) * stride; j++) {
          posArray[j] = posArray[j + stride];
        }
        // Append the current position at the end of the current trail segment.
        const baseIndex = (trail.count - 1) * stride;
        posArray[baseIndex] = pos.x;
        posArray[baseIndex + 1] = pos.y;
        posArray[baseIndex + 2] = pos.z;

        // Increase the trail count gradually until we reach the maximum.
        if (trail.count < maxTrailLength) {
          trail.count++;
        }
      }
    
      // Update the progress attribute so that the oldest point is 0 and the newest is 1.
      for (let j = 0; j < trail.count; j++) {
        progArray[j] = (trail.count > 1) ? (j / (trail.count - 1)) : 1;
      }
    
      // Update the draw range and mark attributes as needing an update.
      trail.line.geometry.setDrawRange(0, trail.count);
      trail.line.geometry.attributes.position.needsUpdate = true;
      trail.line.geometry.attributes.progress.needsUpdate = true;
    });

    // Advance the sample index (adjust speed as desired)
    currentSample++;
  }

  renderer.render(scene, camera);
}

init();
animate();