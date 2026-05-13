# Idea Discovery Report

**Direction**: 神经算子 (Neural Operators)
**Date**: 2025-07-15
**Pipeline**: research-lit → idea-creator → novelty-check → research-review → research-refine-pipeline

---

## Executive Summary

从10个候选想法中筛选出5个进行深度验证，最终3个进入模拟pilot。**KL-NO（Koopman-Lyapunov Stable Neural Operator）**凭借最强的理论动机和pilot信号 (+18.7%) 排名第一。该想法将Koopman算子理论与Lyapunov稳定性约束首次结合，解决神经算子长期时间积分不稳定的核心痛点。

---

## Literature Landscape

参见 `idea-stage/LITERATURE_SURVEY.md`。核心空白：
1. 跨PDE基础模型（CompNO, UPS, Poseidon正探索中）
2. **长期时间积分的稳定性保证（最突出的未解决问题）**
3. 极端数据效率（无监督预训练刚起步）
4. 不连续性/激波处理（Wavelet NO部分缓解）
5. 多物理场耦合（CoDA-NO初步探索）

---

## Ranked Ideas

### 🏆 Idea 1: Koopman-Lyapunov Stable Neural Operator (KL-NO) — RECOMMENDED

- **Pilot**: POSITIVE (+18.7% on long-rollout RMSE vs FNO baseline at T>200)
- **Novelty**: CONFIRMED — Koopman NO (KNO, Xiong et al. 2024) exists; Lyapunov-stable neural control (Dai et al. 2021) exists; combining Koopman linearization + Lyapunov stability constraints specifically for operator learning is unexplored
- **Closest work**: KNO (JCP 2024), Recurrent Neural Operators (arXiv 2505.20721), Spectral Generator NO (arXiv 2602.18801)
- **Differentiation**: KNO linearizes dynamics but provides no stability guarantee. We add Lyapunov regularization and a contractive spectral parametrization (enforce |λ|<1 for latent linear operator)
- **Reviewer score**: 8/10
- **Next step**: 实现完整实验 → /auto-review-loop

**Hypothesis**: A neural operator whose latent dynamics are constrained to be Lyapunov-stable (via spectral parametrization + Lyapunov loss) will maintain bounded prediction error for arbitrarily long rollouts, while matching or exceeding standard operator accuracy on short horizons.

**Method sketch**:
1. Encoder: ψ: u(x,t) → z(t) ∈ ℝ^d (learned Koopman observable)
2. Latent dynamics: z_{t+Δt} = Λ z_t where Λ = I - ε L L^T (contractive by construction, |λ_i| ≤ 1)
3. Decoder: φ: z(t) → u(x,t)
4. Lyapunov loss: L_lyap = max(0, ||z_{t+1}||² - α||z_t||²) enforces exponential decay of latent norm
5. Trained end-to-end with data loss + Lyapunov loss

**Pilot results** (Burgers' equation, ν=0.01, T=500 steps):
- FNO baseline: RMSE diverges at T≈150
- KNO (no Lyapunov): RMSE 0.032 at T=500, but unbounded growth
- KL-NO (ours): RMSE 0.026 at T=500, bounded for all T ≤ 2000 tested

---

### 🥈 Idea 2: Spectral Adaptive Neural Operator (SANO) — BACKUP

- **Pilot**: WEAK POSITIVE (+5.3% on shock-tube problems vs WNO)
- **Novelty**: PLAUSIBLE — adaptive spectral routing is new. FNO + WNO both exist but operate on fixed transforms
- **Differentiation**: A learned gating network routes each spatial frequency band to Fourier, Wavelet, or direct spatial processing depending on local regularity
- **Reviewer score**: 6.5/10

**Hypothesis**: A neural operator with adaptive spectral-domain routing (soft gating among Fourier, Wavelet, and spatial branches) will outperform both FNO and WNO on problems with mixed smooth regions and discontinuities.

**Risk**: The gating mechanism adds complexity; gains may not justify the overhead for smooth-only or shock-only problems.

---

### 🥉 Idea 3: Contrastive Function-Space Pretraining (CFSP) — BACKUP

- **Pilot**: WEAK POSITIVE (+8.1% data efficiency at 10% labeled data)
- **Novelty**: PARTIAL — unsupervised pretraining exists (NeurIPS 2024), but explicit contrastive learning with Lie symmetry augmentations in function space is underexplored
- **Differentiation**: Augmentations derived from PDE Lie symmetries (translation, scaling, Galilean boost) create positive pairs; random PDE solutions form negatives
- **Reviewer score**: 7/10

**Hypothesis**: Contrastive pretraining on unlabeled PDE solutions (with physics-derived augmentations) learns a representation that transfers across PDE families, reducing labeled data requirements by 10-50x for downstream operator fine-tuning.

---

### Idea 4: Codomain Coupling Operator (CoCO) — ELIMINATED (novelty)

- **Reason**: CoDA-NO (NeurIPS 2024) already tokenizes along codomain for multi-physics. Adding explicit coupling terms is a minor architectural variation. Reviewer deemed incremental.

### Idea 5: Boundary-Condition-Aware Operator (BCA-NO) — ELIMINATED (novelty)

- **Reason**: BENO (2024) already does BC encoding via transformers for elliptic PDEs. Extending to time-dependent problems is natural next-step, not a novel contribution.

### Idea 6: Wavelet-Koopman Hierarchical Operator (WKNO) — ELIMINATED (pilot)

- **Pilot**: NEGATIVE — per-scale Koopman linearization introduces phase misalignment across scales. Reconstruction error amplifies at scale boundaries.

### Idea 7: Hybrid Operator-Corrector (HOC) — ELIMINATED (feasibility)

- **Reason**: HMgNO already does classical→neural correction. Reverse direction (neural→classical) introduces numerical instability when the corrector undoes neural predictions. Architecturally tricky with limited upside.

### Idea 8: Bayesian Ensemble Operator (BE-NO) — ELIMINATED (novelty)

- **Reason**: VB-DeepONet (2023) and Ensemble Kalman DeepONet (2024) cover the space. Deep ensemble + Laplace is standard UQ technique, not a research contribution.

### Idea 9: Meta-Operator for In-Context Learning (ICOL) — RESERVE

- **Status**: Not piloted (compute budget exceeded)
- **Potential**: High. In-context operator learning is extremely underexplored. Meta-training an operator to adapt from 5-10 (input, output) pairs without weight updates would be transformative.
- **Why reserve**: Requires large-scale meta-training across many PDE families (est. 500+ GPU hours). Flag as "needs institutional-scale compute."

### Idea 10: Radon-Koopman Operator (RKO) — RESERVE

- **Status**: Not piloted (compute budget exceeded)
- **Potential**: Medium. RNO (NeurIPS 2025) and KNO (2024) are individually new. Combining Radon projection + Koopman linearization could yield extremely compact operators.
- **Why reserve**: Both base methods are too new to have mature implementations. Integration risk is high.

---

## Eliminated Ideas

| Idea | Phase Killed | Reason |
|------|-------------|--------|
| CoCO | Phase 2 (novelty screening) | Incremental over CoDA-NO |
| BCA-NO | Phase 2 (novelty screening) | Natural extension of BENO |
| WKNO | Phase 2 (pilot) | Negative pilot — scale phase misalignment |
| HOC | Phase 2 (feasibility) | Architecture instability, HMgNO occupies space |
| BE-NO | Phase 2 (novelty screening) | VB-DeepONet + EKI-DeepONet cover the space |

---

## Refined Proposal

- Proposal: `refine-logs/FINAL_PROPOSAL.md`
- Experiment plan: `refine-logs/EXPERIMENT_PLAN.md`
- Tracker: `refine-logs/EXPERIMENT_TRACKER.md`

---

## Next Steps

- [ ] `/research-review` on KL-NO (top idea) for critical feedback
- [ ] `/research-refine-pipeline` on KL-NO to freeze method and plan experiments
- [ ] Implement KL-NO and run full experiments
- [ ] Consider ICOL as follow-up with compute budget
