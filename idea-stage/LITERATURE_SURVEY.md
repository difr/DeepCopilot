# Literature Survey: 神经算子 (Neural Operators)

**Date**: 2025-07-15
**Scope**: Neural operator architectures, training methods, applications, and open problems (2022–2025)

---

## 1. Landscape Overview

Neural operators learn mappings between infinite-dimensional function spaces, enabling mesh-invariant and resolution-invariant PDE solving. The field has exploded since the introduction of Fourier Neural Operators (FNO, Li et al. 2021) and DeepONet (Lu et al. 2021).

### 1.1 Major Architecture Families

| Family | Core Idea | Strengths | Limitations |
|--------|-----------|-----------|-------------|
| **FNO** | Convolution in Fourier frequency domain | Fast, resolution-invariant, strong for periodic BCs | Struggles with irregular geometry, discontinuities |
| **DeepONet** | Branch/trunk network; universal operator approximator | Theoretically grounded, flexible I/O | Slower, harder to scale to 3D |
| **GINO** | Graph + FNO hybrid for irregular meshes | Handles complex geometry | Higher computational cost |
| **Transolver** | Transformer-based operator with physics-aware attention | Strong on irregular domains, SOTA on multiple benchmarks | Large model size, data-hungry |
| **Koopman NO (KNO)** | Koopman operator theory → linear dynamics in latent space | Mesh-free, excellent long-term prediction | Requires careful observable design |
| **Wavelet NO** | Wavelet transform instead of Fourier | Better for signals with discontinuities | Less theoretical backing |
| **Spectral NO** | General spectral expansions (Chebyshev, spherical harmonics) | Flexible basis choice | Domain-specific |
| **Taylor Mode NO** | Taylor-mode AD for efficient high-order derivatives in PINOs | 10-100x speedup for physics-informed training | Limited to differentiable physics |

### 1.2 Key Sub-Directions

**Physics-Informed Neural Operators (PINO)**
- Combine data + PDE residual loss → better generalization with less data
- Zero-shot physics-informed fine-tuning: adapt pretrained operator to new PDE with only physics loss
- Replay-based continual learning for PINO: handle OOD without catastrophic forgetting

**Data Efficiency**
- Unsupervised pretraining via mask reconstruction on function spaces
- In-context operator learning: few-shot adaptation without weight updates
- Transfer learning from coarse to fine solvers (Anima Anandkumar lab, Caltech)

**Geometry & Multi-Scale**
- GINO and Transolver lead on irregular domains
- Koopman methods for multiscale dynamics
- Wavelet-based approaches for scale separation

**Theory**
- Universal approximation bounds for various architectures established
- Convergence rates and stability analysis still lagging
- Mixed-precision training feasibility shown recently

---

## 2. Open Problems & Structural Gaps

### 2.1 Data Bottleneck
Most neural operators require thousands of high-fidelity PDE simulations. Unsupervised pretraining and physics-informed losses help, but a 10-100x reduction in data requirements is still needed for practical adoption.

### 2.2 Long-Time Stability
Neural operators tend to drift or blow up on long rollout horizons (>100 time steps). Koopman approaches partially address this by linearizing dynamics, but general stability guarantees are missing.

### 2.3 Discontinuities & Shocks
Fourier-based methods (FNO, U-FNO) struggle with sharp gradients (shocks, phase boundaries). Wavelet and attention-based methods are better but not yet reliable.

### 2.4 Cross-PDE Generalization
Most operators are trained on one specific PDE (Navier-Stokes OR Darcy OR Allen-Cahn). Foundation models for operator learning remain largely unexplored—can we train one operator that adapts to many PDEs?

### 2.5 Irregular & Dynamic Geometry
While GINO and Transolver make progress, handling time-varying geometries (e.g., fluid-structure interaction, fracture propagation) remains open.

### 2.6 Computational Scaling
Training on 3D+time problems (climate, turbulence) is extremely expensive. More efficient architectures (sparse spectral methods, hierarchical approaches) are needed.

### 2.7 Integration with Classical Solvers
Hybrid approaches (neural operator + classical numerical method) are underexplored. Could provide the best of both worlds: speed + guarantees.

### 2.8 Multi-Physics Coupling
Real-world problems involve coupled physics (fluid-thermal, electro-mechanical). Current operators handle single-physics systems well but coupled systems remain challenging.

---

## 3. Top Venues & Active Groups

- **Key groups**: Anima Anandkumar (Caltech/NVIDIA), George Karniadakis (Brown), Paris Perdikaris (Penn), Kamyar Azizzadenesheli (NVIDIA), Lu Lu (Yale)
- **Venues**: NeurIPS, ICML, ICLR, J. Computational Physics, CMAME, PNAS
- **Recent workshops**: AI4Science (NeurIPS), ML4PhysicalSciences

---

## 4. Recommended Focus Directions

Based on gap analysis, the highest-impact directions are:

1. **Cross-PDE foundation operator** — one model, many PDEs (high-risk, high-reward)
2. **Efficient long-time integration** — stability guarantees or Lyapunov-inspired architectures
3. **Extreme data efficiency** — reducing labeled data needs by 100x via self-supervised + physics
4. **Discontinuity-aware operators** — handling shocks without sacrificing smooth-region accuracy
5. **Multi-physics operator coupling** — modular neural operators for coupled systems
